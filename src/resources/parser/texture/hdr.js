import { http } from '../../../net/http.js';
import {
    TEXHINT_ASSET,
    ADDRESS_REPEAT, ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST_MIPMAP_NEAREST, FILTER_NEAREST,
    PIXELFORMAT_R8_G8_B8_A8,
    TEXTURETYPE_RGBE
} from '../../../graphics/constants.js';
import { Texture } from '../../../graphics/texture.js';

class Reader {
    constructor(data) {
        this.view = new DataView(data);
        this.offset = 0;
    }

    readLine() {
        const view = this.view;
        let result = "";
        while (true) {
            if (this.offset >= view.byteLength) {
                break;
            }

            const c = String.fromCharCode(this.readUint8());
            if (c === '\n') {
                break;
            }
            result += c;
        }
        return result;
    }

    readUint8() {
        return this.view.getUint8(this.offset++);
    }

    readUint8s(result) {
        const view = this.view;
        for (let i = 0; i < result.length; ++i) {
            result[i] = view.getUint8(this.offset++);
        }
    }

    peekUint8s(result) {
        const view = this.view;
        for (let i = 0; i < result.length; ++i) {
            result[i] = view.getUint8(this.offset + i);
        }
    }
}

/**
 * @private
 * @class
 * @name HdrParser
 * @implements {TextureParser}
 * @classdesc Texture parser for hdr files.
 */
class HdrParser {
    constructor(registry) {
        this.maxRetries = 0;
    }

    load(url, callback, asset) {
        const options = {
            cache: true,
            responseType: "arraybuffer",
            retry: this.maxRetries > 0,
            maxRetries: this.maxRetries
        };
        http.get(url.load, options, callback);
    }

    open(url, data, device) {
        const textureData = this.parse(data);

        if (!textureData) {
            return null;
        }

        const texture = new Texture(device, {
            name: url,
            // #if _PROFILER
            profilerHint: TEXHINT_ASSET,
            // #endif
            addressU: ADDRESS_REPEAT,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_NEAREST_MIPMAP_NEAREST,
            magFilter: FILTER_NEAREST,
            width: textureData.width,
            height: textureData.height,
            levels: textureData.levels,
            format: PIXELFORMAT_R8_G8_B8_A8,
            type: TEXTURETYPE_RGBE,
            // RGBE can't be filtered, so mipmaps are out of the question! (unless we generated them ourselves)
            mipmaps: false
        });

        texture.upload();

        return texture;
    }

    // https://floyd.lbl.gov/radiance/refer/filefmts.pdf with help from http://www.graphics.cornell.edu/~bjw/rgbe/rgbe.c
    parse(data) {
        const reader = new Reader(data);

        // require magic
        const magic = reader.readLine();
        if (!magic.startsWith('#?RADIANCE')) {
            this._error("radiance header has invalid magic");
            return null;
        }

        // read header variables
        const variables = { };
        while (true) {
            const line = reader.readLine();
            if (line.length === 0) {
                // empty line signals end of header
                break;
            } else {
                const parts = line.split('=');
                if (parts.length === 2) {
                    variables[parts[0]] = parts[1];
                }
            }
        }

        // we require FORMAT variable
        if (!variables.hasOwnProperty('FORMAT')) {
            this._error("radiance header missing FORMAT variable");
            return null;
        }

        // read the resolution specifier
        const resolution = reader.readLine().split(' ');
        if (resolution.length !== 4) {
            this._error("radiance header has invalid resolution");
            return null;
        }

        const height = parseInt(resolution[1], 10);
        const width = parseInt(resolution[3], 10);
        const pixels = this._readPixels(reader, width, height, resolution[0] === '-Y');

        if (!pixels) {
            return null;
        }

        // create texture
        return {
            width: width,
            height: height,
            levels: [pixels]
        };
    }

    _readPixels(reader, width, height, flipY) {
        // out of bounds
        if (width < 8 || width > 0x7fff) {
            return this._readPixelsFlat(reader, width, height);
        }

        const rgbe = [0, 0, 0, 0];

        // check first scanline width to determine whether the file is RLE
        reader.peekUint8s(rgbe);
        if ((rgbe[0] !== 2 || rgbe[1] !== 2 || (rgbe[2] & 0x80) !== 0)) {
            // not RLE
            return this._readPixelsFlat(reader, width, height);
        }

        // allocate texture buffer
        const buffer = new ArrayBuffer(width * height * 4);
        const view = new Uint8Array(buffer);
        let scanstart = flipY ? width * 4 * (height - 1) : 0;
        let x, y, i, channel, count, value;

        for (y = 0; y < height; ++y) {
            // read scanline width specifier
            reader.readUint8s(rgbe);

            // sanity check it
            if ((rgbe[2] << 8) + rgbe[3] !== width) {
                this._error("radiance has invalid scanline width");
                return null;
            }

            // each scanline is stored by channel
            for (channel = 0; channel < 4; ++channel) {
                x = 0;
                while (x < width) {
                    count = reader.readUint8();
                    if (count > 128) {
                        // run of the same value
                        count -= 128;
                        if (x + count > width) {
                            this._error("radiance has invalid scanline data");
                            return null;
                        }
                        value = reader.readUint8();
                        for (i = 0; i < count; ++i) {
                            view[scanstart + channel + 4 * x++] = value;
                        }
                    } else {
                        // non-run
                        if (count === 0 || x + count > width) {
                            this._error("radiance has invalid scanline data");
                            return null;
                        }
                        for (i = 0; i < count; ++i) {
                            view[scanstart + channel + 4 * x++] = reader.readUint8();
                        }
                    }
                }
            }

            scanstart += width * 4 * (flipY ? -1 : 1);
        }

        return view;
    }

    _readPixelsFlat(reader, width, height) {
        const filePixelBytes = reader.view.buffer.byteLength - reader.offset;
        return filePixelBytes === width * height * 4 ? new Uint8Array(reader.view.buffer, reader.offset) : null;
    }

    _error(message) {
        // #if _DEBUG
        console.error(message);
        // #endif
    }
}

export { HdrParser };
