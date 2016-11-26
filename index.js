#!/usr/bin/env node

'use strict';

const argv = require('commander')
    .option('-a, --attempts [num]', 'number of times to try to connect to Photobucket', parseInt, 3)
    .option('-m, --media-timeout [ms]', 'time between requests (in milliseconds) to Photobucket\'s media servers', parseInt, 500)
    .option('-l, --links [file]', 'write the links to file instead of downloading them')
    .option('-p, --page [num]', 'starting page number', parseInt, 1)
    .option('-o, --output [path]', 'file/directory that media is saved to/in (if directory, will be created if it doesn\'t exist)')
    .option('-s, --site-timeout [ms]', 'time between requests (in milliseconds) to Photobucket\'s website/API.', parseInt, 2000)
    .option('-u, --url <url>', 'URL of the album.')
    .option('-v, --verbose', 'describe every minute detail in every step we do')
    .parse(process.argv);

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
const fs = require('fs-extra');
const request = require('request');
const urlMod = require('url');

const startingPage = argv.page;

const url = argv.url.indexOf('?') > -1 ? argv.url.split('?')[0] : argv.url;
const parsedUrl = urlMod.parse(url);

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

function getUrl(obj) {
    return obj.fullsizeUrl;
}

function downloadFile(obj, downloadCb, file) {
    let outFile = argv.output;

    if (typeof file === 'undefined') {
        fs.ensureDirSync(argv.output);
        outFile += (argv.output[argv.output.length - 1] === '/' ? '' : '/') + obj.titleOrFilename + '.' + obj.ext;
    }

    retry(argv.mediaTimeout, (retryCb) => {
        const fileStream = fs.createWriteStream(outFile);

        fileStream.on('close', () => {
            console.log('Downloaded %s', outFile);
            retryCb(null);
        });

        request({
            accept: 'image/webp,image/*,*/*;q=0.8',
            uri: getUrl(obj),
        }).on('error', (reqErr) => {
            if (reqErr !== null) {
                retryCb(reqErr, null);
            }
        }).pipe(fileStream);
    }, downloadCb);
}

function req(opts, reqCb) {
    retry(argv.siteTimeout, (retryCb) => {
        console.log('\nTrying %s...\n', opts.uri + (typeof opts.qs === 'undefined' ? '' : ' (page #' + opts.qs.page + ')'));
        request(opts, (reqErr, _, reqBody) => {
            if (reqErr) {
                retryCb(reqErr, null);
            } else {
                retryCb(null, reqBody);
            }
        });
    }, reqCb);
}

req({
    method: 'GET',
    uri: url + (url.indexOf('library') > -1 || url.indexOf('album') > -1 ? '?page=' + startingPage : ''),
}, (reqErr, reqBody) => {
    if (reqErr === null) {
        /*let rawJsonAttempt = reqBody.split('\n').filter((line) => {
            return line.indexOf('collectionData:') > -1 && line.indexOf('objects') > -1;
        }); */
        const rawJsonAttempt = reqBody.split('\n').filter((line) => {
            return line.indexOf('"pictureId"') > -1;
        });
        const hashAttempt = reqBody.split('\n').filter((line) => {
            return line.indexOf('<input type="hidden"') > -1 && line.indexOf('id="token"') > -1;
        });

        if (rawJsonAttempt.length === 1 && hashAttempt.length === 1) {
            //let fixedJson = /^\s*collectionData:\s?({.+}),$/.exec(rawJsonAttempt[0]);
            //let fixedJson = /.+({.*"pictureId".*})(?:\);)|(?:,)$/.exec(rawJsonAttempt[0]);
            const fixedJson = (/^[A-Za-z(),\s\.:]+({.*"pictureId".*})(?:(?:\);)|(?:,))$/).exec(rawJsonAttempt[0]);
            const hash = (/<input type="hidden" .+ id="token" value="(.+)"\s?\/>/).exec(hashAttempt[0]);

            if (fixedJson === null) {
                console.log('ERROR: JSON RegExp gave no results!');
            } else if (hash === null) {
                console.log('ERROR: Hash RegExp gave no results!');
            } else {
                let parsedJson = {};
                let parseSuccess = false;

                try {
                    parsedJson = JSON.parse(fixedJson[1]);
                    parseSuccess = true;
                } catch (parseErr) {
                    /* console.log(fixedJson[1]);
                    throw parseErr;*/
                    console.log('ERROR: Couldn\'t parse JSON!');
                }

                if (parseSuccess) {
                    if (typeof parsedJson.items === 'undefined') {
                        console.log('Detected link to be image\n');
                        if (typeof argv.links === 'string') {
                            fs.outputFile(argv.links, getUrl(parsedJson), (writeErr) => {
                                if (writeErr === null) {
                                    console.log('Done!');
                                    process.exit(0);
                                } else {
                                    console.log(writeErr);
                                }
                            });
                        } else {
                            downloadFile(parsedJson, () => {
                                console.log('\nDone!');
                                process.exit(0);
                            }, true);
                        }
                    } else {
                        let pagesNeeded = 1;
                        const newStartingPage = startingPage + 1;

                        while (pagesNeeded * parsedJson.pageSize < parsedJson.total) {
                            pagesNeeded += 1;
                        }

                        console.log('Detected link to be album (%d images; %d pages at %d files per page)\n', parsedJson.total, pagesNeeded, parsedJson.pageSize);

                        const urls = [...Array(pagesNeeded - newStartingPage + 1).keys()].map((val) => {
                            return {
                                headers: {
                                    'accept-encoding': 'gzip',
                                    referer: url + '?sort=9&page=' + (val + newStartingPage - 1),
                                    'user-agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/54.0.2840.99 Safari/537.36',
                                    'x-requested-with': 'XMLHttpRequest',
                                    accept: 'application/json, text/javascript, */*; q=0.01',
                                },
                                method: 'GET',
                                qs: {
                                    'filters[album]': parsedJson.currentAlbumPath, // album path
                                    'filters[album_content]': '2', // unknown default
                                    limit: String(parsedJson.pageSize),
                                    page: String(val + newStartingPage), // page #
                                    linkerMode: '', // unknown default
                                    json: '1', // says we want JSON results
                                    sort: '9', // unknown default
                                    hash: hash[1], // proves that we're actually on the site
                                },
                                uri: urlMod.format({ // api path
                                    host: parsedUrl.host,
                                    pathname: parsedJson.contentFetchUrl,
                                    protocol: 'http',
                                    slashes: true,
                                }),
                            };
                        });

                        if (typeof argv.links === 'string') {
                            async.mapSeries(urls, req, (mapErr, mapRes) => {
                                if (mapErr === null) {
                                    fs.outputFile(argv.links, mapRes.map((page) => {
                                        return JSON.parse(page).body.objects.map(getUrl);
                                    }).reduce((memo, current) => {
                                        return memo.concat(current);
                                    }, parsedJson.items.objects.map(getUrl)).join('\n'), (writeErr) => {
                                        if (writeErr !== null) {
                                            console.log(writeErr);
                                        }
                                    });
                                } else {
                                    console.log(mapErr);
                                }
                            });
                        } else {
                            async.eachSeries(parsedJson.items.objects, downloadFile, (eachErr) => {
                                if (eachErr === null) {
                                    async.eachSeries(urls, (page, eachCb) => {
                                        req(page, (pageReqErr, pageReqRes) => {
                                            if (pageReqErr === null) {
                                                async.eachSeries(JSON.parse(pageReqRes).body.objects, downloadFile, (eachErr2) => {
                                                    eachCb(eachErr2);
                                                });
                                            } else {
                                                eachCb(pageReqErr);
                                            }
                                        });
                                    }, (eachErr2) => {
                                        if (eachErr2 === null) {
                                            console.log('\nDone!');
                                        } else {
                                            console.log(eachErr2);
                                        }
                                    });
                                } else {
                                    console.log(eachErr);
                                }
                            });
                        }
                    }
                }
            }
        } else {
            console.log('ERROR: Couldn\'t find JSON in the page HTML!');
        }
    } else {
        console.log(reqErr);
    }
});
