# PB_Spade [![NPM](https://nodei.co/npm/pb_spade.png?compact=true)](https://www.npmjs.com/package/pb_spade)
Spiritual successor to [PB_Shovel](https://github.com/Daxda/PB_Shovel/). Basically, it takes in [Photobucket](http://photobucket.com) image/album links and downloads them.

## Installation

```
npm i -g pb_spade
```

## Usage

```
  Usage: pb_spade [options]

  Options:

    -h, --help                output usage information
    -a, --attempts [num]      number of times to try to connect to Photobucket
    -m, --media-timeout [ms]  time between requests (in milliseconds) to Photobucket's media servers
    -l, --links [file]        write image links to a file instead of downloading them
    -p, --page [num]          starting page number
    -o, --output [path]       file/directory that media is saved to/in (if directory, will be created if it doesn't exist)
    -s, --site-timeout [ms]   time between requests (in milliseconds) to Photobucket's website/API
    -u, --url <url>           URL of the file/album
    -v, --verbose             describe every minute detail in every step we do
```

## Examples

### Single File

To borrow [an example from PB_Shovel](https://github.com/Daxda/PB_Shovel/#example):

```
pb_spade -u "http://s160.photobucket.com/user/Spinningfox/media/Internet%20Fads/b217a64d.gif.html" -o "waterslide.gif"
```

This will download the file from that Photobucket page and save it as `waterslide.gif` in the current directory.

### Album

```
pb_spade -u "http://s160.photobucket.com/user/Spinningfox/library/Internet%20Fads/Teh%20Interwebs%2053R10U5%208U51N355?sort=3&page=1" -o "serious_business/"
```

This will download all the files in that Photobucket album and save them in the `serious_business/` directory (inside the current directory). The directory will be created if it doesn't already exist.

PB_Spade does not yet have [support for nested albums/folders](https://github.com/r3c0d3x/PB_Spade/issues/2).

### Image URL Lists

```
pb_spade -u "http://s160.photobucket.com/user/Spinningfox/library/Internet%20Fads/Teh%20Interwebs%2053R10U5%208U51N355?sort=3&page=1" -l "serious_business_links.txt"
```

This will write every image's direct URL (from the album) to a newline-delimited file with the name `serious_business_links.txt` in the current directory.