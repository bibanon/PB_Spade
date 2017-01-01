#!/usr/bin/env node

'use strict';

const commander = require('commander');

const argv = commander
    .option('-a, --attempts [num]', 'number of times to try to connect to Photobucket', parseInt, 3)
    .option('-f, --fake', 'simulate (don\'t download anything)', false)
    .option('-m, --media-timeout [ms]', 'time between requests (in milliseconds) to Photobucket\'s media servers', parseInt, 500)
    //.option('-l, --links [file]', 'write image links to a file instead of downloading them')
    .option('-o, --output [path]', 'file/directory that media is saved to/in (if directory, will be created if it doesn\'t exist)')
    .option('-r, --recursive', 'if album, get subalbums (including their subalbums)', false)
    .option('-s, --site-timeout [ms]', 'time between requests (in milliseconds) to Photobucket\'s website/API', parseInt, 2000)
    .option('-u, --url <url>', 'URL of the file/album')
    .option('-v, --verbose', 'describe every minute detail in every step we do', false)
    .parse(process.argv);

if (process.argv.length === 2) {
    commander.help();
    process.exit(1);
}

argv.options.forEach((option) => {
    if (option.required !== 0 && typeof argv[option.long.slice(2)] === 'undefined') {
        console.log('\n  error: missing required parameter \'%s\'', option.long);
        process.exit(1);
    }
});

if (typeof argv.output === 'undefined' && typeof argv.links === 'undefined') {
    console.log('\n  error: missing required parameter \'--links\' or \'--output\'');
    process.exit(1);
}

const async = require('async');
const extend = require('deep-extend');
const fs = require('fs-extra');
const path = require('path');
const request = require('request');
const touch = require('touch');
const url = require('url');

function opts(custom) {
    return extend({
        headers: {
            'accept-language': 'en-US,en;q=0.8',
            'content-type': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'user-agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/54.0.2840.99 Safari/537.36',
        },
        gzip: true,
        method: 'GET',
    }, custom);
}

function apiOpts(custom) {
    return extend(opts({
        headers: {
            accept: 'application/json, text/javascript, */*; q=0.01',
            'x-requested-with': 'XMLHttpRequest',
        },
        qs: {
            json: 1,
        },
    }), custom);
}

function retry(timeout, task, fnCb) {
    let attempts = 0;

    async.retry({
        interval: timeout,
        times: argv.attempts,
    }, (retryCb) => {
        attempts += 1;
        if (attempts === 1) {
            setTimeout(() => {
                task(retryCb);
            }, timeout);
        } else {
            task(retryCb);
        }
    }, fnCb);
}

function req(customOpts, reqCb) {
    retry(argv.siteTimeout, (retryCb) => {
        if (argv.verbose) {
            if (typeof customOpts.qs !== 'undefined' && typeof customOpts.qs.page !== 'undefined') {
                console.log(`Trying ${customOpts.uri}... (page #${customOpts.qs.page})`);
            } else {
                console.log(`Trying ${customOpts.uri}...`);
            }
        }
        setTimeout(() => {
            request(customOpts, (reqErr, _, reqBody) => {
                if (reqErr === null) {
                    return retryCb(null, reqBody);
                } else {
                    return retryCb(reqErr, null);
                }
            });
        }, argv.siteTimeout);
    }, reqCb);
}

function apiReq(customOpts, reqCb) {
    req(customOpts, (reqErr, reqBody) => {
        if (reqErr === null) {
            let data = {};
            try {
                data = JSON.parse(reqBody);
            } catch (jsonErr) {
                if (argv.verbose) {
                    console.log({
                        status: 'jsonErr',
                        opts: customOpts,
                        err: reqErr,
                        res: reqBody,
                    });
                }
                return reqCb(jsonErr, null);
            }
            if (argv.verbose) {
                console.log({
                    status: 'normal',
                    opts: customOpts,
                    err: reqErr,
                    res: data,
                });
            }
            return reqCb(null, data);
        } else {
            if (argv.verbose) {
                console.log({
                    status: 'reqErr',
                    opts: customOpts,
                    err: reqErr,
                    res: reqBody,
                });
            }
            return reqCb(reqErr, null);
        }
    });
}

class File {
    constructor(rawUrl, fns) {
        this.type = 'file';
        this.url = rawUrl;
        this.filename = path.parse(this.url).base;
        if (typeof fns !== 'undefined') {
            this.fns = fns;
        } else {
            this.fns = {};
        }
    }

    static fromObj(obj, fns) {
        return new File(obj.fullsizeUrl, typeof fns === 'object' ? fns : undefined);
    }

    download(toPath, cb) {
        if (typeof this.fns.beforeDl === 'function') {
            this.fns.beforeDl(this);
        }
        if (!argv.fake) {
            retry(argv.mediaTimeout, (retryCb) => {
                fs.ensureDirSync(path.parse(toPath).dir);
                const fileStream = fs.createWriteStream(toPath);
                let created = '';

                fileStream.on('close', () => {
                    if (typeof this.fns.afterDl === 'function') {
                        this.fns.afterDl(this);
                    }
                    if (created !== '') {
                        touch(toPath, {
                            mtime: new Date(created),
                        }, () => {
                            return retryCb(null);
                        });
                    }
                });

                setTimeout(() => {
                    request({
                        accept: 'image/webp,image/*',
                        uri: this.url,
                    }, (reqErr, reqRes) => {
                        if (reqErr === null) {
                            if (typeof reqRes.headers['last-modified'] === 'string') {
                                created = reqRes.headers['last-modified'];
                            }
                        } else {
                            retryCb(reqErr);
                        }
                    }).on('error', (reqErr) => {
                        if (reqErr !== null) {
                            return retryCb(reqErr);
                        }
                    }).pipe(fileStream);
                }, argv.mediaTimeout);
            }, cb);
        } else {
            cb(null);
        }
    }
}

class Album {
    constructor(originalUrl, albumPath, fns) {
        this.url = url.parse(originalUrl);
        this.type = 'album';
        this.path = albumPath;
        this.perPage = 24;
        this.total = null;
        if (typeof fns !== 'undefined') {
            this.fns = fns;
        } else {
            this.fns = {};
        }
    }

    page(num, cb, fns) {
        if (typeof this.fns.beforePage === 'function') {
            this.fns.beforePage(num);
        }
        apiReq(apiOpts({
            qs: {
                'filters[album]': this.path,
                limit: this.perPage, // page uses 24 by default
                page: num,
            },
            uri: `${this.url.protocol}//${this.url.hostname}/component/Common-PageCollection-Album-AlbumPageCollection`,
        }), (reqErr, reqBody) => {
            if (reqErr === null) {
                this.total = reqBody.body.total;
                if (typeof this.fns.afterPage === 'function') {
                    this.fns.afterPage(num);
                }
                return cb(null, {
                    files: reqBody.body.objects.map((obj) => {
                        return File.fromObj(obj, typeof fns === 'object' ? fns : undefined);
                    }),
                    offset: reqBody.body.currentOffset,
                    total: this.total,
                });
            } else {
                return cb(reqErr, null);
            }
        });
    }

    files(cb, fns) {
        let out = [];

        this.page(1, (pageErr, pageData) => {
            if (pageErr === null) {
                out = pageData.files;

                let pagesNeeded = 0;

                if (this.total > 0) {
                    while (pagesNeeded * this.perPage < this.total) {
                        pagesNeeded += 1;
                    }

                    pagesNeeded -= 1; // because we already did the first page

                    return async.mapSeries([...Array(pagesNeeded).keys()].map((num) => {
                        return num + 2;
                    }), (num, mapCb) => {
                        this.page(num, (mapPageErr, mapPageData) => {
                            if (mapPageErr === null) {
                                return mapCb(null, mapPageData.files);
                            } else {
                                return mapCb(mapPageErr, null);
                            }
                        }, typeof fns === 'object' ? fns : undefined);
                    }, (mapErr, mapData) => {
                        if (mapErr === null) {
                            mapData.forEach((page) => {
                                out = out.concat(page);
                            });
                            return cb(null, out);
                        } else {
                            return cb(mapErr, null);
                        }
                    });
                } else {
                    cb(null, []);
                }
            } else {
                return cb(pageErr, null);
            }
        }, typeof fns === 'object' ? fns : undefined);
    }

    download(directory, cb, recursive, recursiveFns) {
        if (typeof this.fns.afterAlbumDl === 'function') {
            this.fns.beforeAlbumDl();
        }
        this.files((filesErr, filesData) => {
            if (filesErr === null) {
                async.eachSeries(filesData, (file, fileEachCb) => {
                    file.download(directory + file.filename, (dlErr) => {
                        fileEachCb(dlErr);
                    });
                }, (eachErr) => {
                    if (eachErr === null) {
                        if (typeof this.fns.afterAlbumDl === 'function') {
                            this.fns.afterAlbumDl();
                        }
                        if (recursive) {
                            this.subalbums((subalbumsErr, subalbumsData) => {
                                if (subalbumsErr === null) {
                                    if (subalbumsData.length === 0) {
                                        if (typeof this.fns.noSubAlbums === 'function') {
                                            this.fns.noSubAlbums();
                                        }
                                    } else {
                                        if (typeof this.fns.beforeRecursiveAlbumDl === 'function') {
                                            this.fns.beforeRecursiveAlbumDl(subalbumsData.length);
                                        }
                                    }
                                    async.eachSeries(subalbumsData, (subalbum, subalbumEachCb) => {
                                        console.log(subalbum);
                                        subalbum.album.download(`${directory + subalbum.title.replace(/[\\/><|:&"?*]/g, '_')}/`, subalbumEachCb, true);
                                    }, (subalbumDlErr) => {
                                        if (subalbumDlErr === null) {
                                            if (typeof this.fns.afterRecursiveAlbumDl === 'function') {
                                                this.fns.afterRecursiveAlbumDl();
                                            }
                                            cb(null);
                                        } else {
                                            cb(subalbumDlErr);
                                        }
                                    });
                                } else {
                                    cb(subalbumsErr);
                                }
                            }, recursiveFns ? this.fns : undefined);
                        } else {
                            cb(null);
                        }
                    } else {
                        cb(eachErr);
                    }
                });
            } else {
                cb(filesErr);
            }
        });
    }

    subalbums(cb, fns) {
        apiReq(apiOpts({
            qs: {
                albumPath: this.path,
                fetchSubAlbumsOnly: true,
                deferCollapsed: true,
            },
            uri: `${this.url.protocol}//${this.url.hostname}/component/Albums-SubalbumList`,
        }), (reqErr, reqBody) => {
            if (reqErr === null) {
                if (typeof fns === 'object') {
                    cb(null, reqBody.body.subAlbums.map((subalbum) => {
                        return {
                            album: new Album(subalbum.linkUrl, subalbum.path, typeof fns === 'object' ? fns : undefined),
                            title: subalbum.title,
                        };
                    }));
                } else {
                    cb(null, reqBody.body.subAlbums.map((subalbum) => {
                        return {
                            album: new Album(subalbum.linkUrl, subalbum.path, typeof fns === 'object' ? fns : undefined),
                            title: subalbum.title,
                        };
                    }));
                }
            } else {
                cb(reqErr, null);
            }
        });
    }
}

function handleUrl(originalUrl, cb, fns) {
    const fixedUrl = `${(originalUrl.indexOf('http') === 0 ? originalUrl : `http://${originalUrl}`).split('?')[0]}?page=1`;
    req(opts({
        uri: fixedUrl,
    }), (reqErr, reqBody) => {
        if (reqErr === null) {
            const lines = reqBody.split('\n');
            let albumPathAttempt = lines.filter((line) => {
                return line.indexOf('queryObj:') > -1 && line.indexOf('"album":') > -1;
            });

            if (albumPathAttempt.length === 1) {
                albumPathAttempt = /\s*queryObj:\s?{.+"album":"([%\w\d\s\\\/]+)",.+},/.exec(albumPathAttempt[0]);

                if (albumPathAttempt === null) {
                    return cb('Couldn\'t parse album object data from webpage.', null);
                } else {
                    if (typeof fns === 'object') {
                        return cb(null, new Album(fixedUrl, JSON.parse(`"${albumPathAttempt[1]}"`), fns));
                    } else {
                        return cb(null, new Album(fixedUrl, JSON.parse(`"${albumPathAttempt[1]}"`)));
                    }
                }
            } else {
                let fileObjAttempt = lines.filter((line) => {
                    return line.indexOf('Pb.Data.Shared.MEDIA') > -1 && line.indexOf('"originalUrl":') > -1;
                });

                if (fileObjAttempt.length === 1) {
                    fileObjAttempt = /"fullsizeUrl":"([:%\w\d\/\\\.]+)"/.exec(fileObjAttempt[0]);

                    if (fileObjAttempt === null) {
                        return cb('Couldn\'t parse file object data from webpage.', null);
                    } else {
                        if (typeof fns === 'object') {
                            return cb(null, new File(JSON.parse(`"${fileObjAttempt[1]}"`), fns));
                        } else {
                            return cb(null, new File(JSON.parse(`"${fileObjAttempt[1]}"`)));
                        }
                    }
                } else {
                    return cb('Cannot parse data from URL.', null);
                }
            }
        } else {
            return cb(reqErr, null);
        }
    });
}

const fns = {
    beforeDl: (file) => {
        console.log(`Downloading "${file.filename}"...`);
    },
    afterDl: (file) => {
        console.log(`Downloading "${file.filename}"... done.`);
    },
    beforePage: (page) => {
        console.log(`Getting files from page ${page}...`);
    },
    afterPage: (page) => {
        console.log(`Getting files from page ${page}... done.`);
    },
    beforeAlbumDl: () => {
        console.log('Getting album...');
    },
    afterAlbumDl: () => {
        console.log('Getting album... done.');
    },
    beforeRecursiveAlbumDl: (len) => {
        console.log(`\nChecking for subalbum(s)... ${len}.`);
        console.log('Getting subalbum(s)...');
    },
    afterRecursiveAlbumDl: () => {
        console.log('Getting subalbum(s)... done.\n');
    },
    noSubAlbums: () => {
        console.log('\nChecking for subalbum(s)... 0.');
    },
};

handleUrl(argv.url, (handleErr, handleData) => {
    if (handleErr === null) {
        if (handleData.type === 'album') {
            if (argv.output[argv.output.length - 1] !== '/') {
                argv.output += '/';
            }
            handleData.download(argv.output, (origDlErr) => {
                if (origDlErr === null) {
                    console.log('\nDone!');
                } else {
                    console.log(origDlErr);
                }
            }, argv.recursive, argv.recursive);
        } else {
            handleData.download(argv.output, (origDlErr) => {
                if (origDlErr === null) {
                    console.log('\nDone!');
                } else {
                    console.log(origDlErr);
                }
            });
        }
    } else {
        console.log(handleErr);
    }
}, fns);
