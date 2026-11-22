/**
 * The real type of an uploaded file, read from its first bytes.
 *
 * A port of the buffer path of `file-type` 22.0.2 (MIT, Sindre Sorhus): the
 * same checks, in the same order, giving the same `ext` and `mime`, so that
 * validation (`extnames`), `file.extname` and the "every allowed format has a
 * signature" refusal behave exactly as they did on top of the library. It
 * replaces the dependency, not the behaviour: `file-type` brought `strtok3`,
 * `token-types`, `@tokenizer/*` and `uint8array-extras` into every
 * application's install tree, for a function ream calls on a buffer it
 * already holds.
 *
 * NAMED DEVIATIONS from `file-type`, all on malformed input:
 * - Nothing here throws. Where the library rejects (a corrupt deflate stream
 *   inside a ZIP, an unexpected internal error), the answer is the one it
 *   gives for a recoverable failure at the same point, or `undefined`.
 * - The bytes read are budgeted ({@link READ_BUDGET}): a file that makes the
 *   detector read more than that (beyond what a real file of any listed
 *   format needs) gets `undefined`. Skipping over bytes costs nothing; only
 *   bytes copied for inspection count.
 * - Inside a gzip stream only the first {@link SAMPLE} decompressed bytes are
 *   looked at, enough to tell a tarball apart, where the library inflates up
 *   to 16 MiB.
 *
 * The extensions this can answer are {@link sniffableExtensions}.
 */

import { errorCode } from '../helpers/errors.js'

/** What the bytes say a file is. */
export interface SniffedFileType {
  /** Extension, lowercase except `Z`, without the dot. */
  readonly ext: string
  readonly mime: string
}

type Found = SniffedFileType | undefined

/** How much of the file the fixed-offset checks see, as upstream. */
const SAMPLE = 4100
/** BOM and ID3 re-entries before giving up. */
const MAXIMUM_REENTRY = 256
/** Bytes copied out for inspection, at most, per detection. */
const READ_BUDGET = 16 * 1024 * 1024
const MAXIMUM_TIFF_TAGS = 512
const MAXIMUM_ZIP_ENTRY = 1024 * 1024
const MAXIMUM_ZIP_ENTRIES = 1024
const MAXIMUM_ZIP_BUFFERED_READ = 2 ** 31 - 1
const ZIP_DATA_DESCRIPTOR = 0x08074b50
const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50
const ZIP_ENCRYPTED = 0xe011cfd0
const ZIP_SYNC_BUFFER = 256 * 1024
const MAXIMUM_PNG_CHUNKS = 512
const MAXIMUM_EBML_DOCTYPE = 64
const MAXIMUM_EBML_ELEMENTS = 256
const MAXIMUM_ASF_OBJECTS = 512

/** The input ended before a read could be satisfied. */
class EndOfInput extends Error {}
/** An untrusted size or offset went past what is allowed. */
class HardLimit extends Error {}
/** A ZIP structure the walk cannot follow; recoverable, like upstream's list. */
class ZipProblem extends Error {}

function found(ext: string, mime: string): SniffedFileType {
  return { ext, mime }
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function latin1(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return text
}

/** `token-types`' `ascii`: the high bit dropped from every byte. */
function ascii(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte & 0x7f)
  return text
}

const utf8 = new TextDecoder('utf-8')

function stringToBytes(text: string, encoding?: 'utf-16le' | 'utf-16be'): number[] {
  const bytes: number[] = []
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (encoding === 'utf-16le') bytes.push(code & 0xff, (code >> 8) & 0xff)
    else if (encoding === 'utf-16be') bytes.push((code >> 8) & 0xff, code & 0xff)
    else bytes.push(code)
  }
  return bytes
}

function checkBytes(
  buffer: Uint8Array,
  header: readonly number[],
  offset = 0,
  mask?: readonly number[],
): boolean {
  for (const [index, expected] of header.entries()) {
    const actual = buffer[index + offset]
    if (mask) {
      if (expected !== ((mask[index] ?? 0) & (actual ?? 0))) return false
    } else if (expected !== actual) {
      return false
    }
  }
  return true
}

function safeBound(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new HardLimit()
  return value
}

/** The tar header checksum: octal sum at 148, the field itself counted as spaces. */
function tarChecksumMatches(buffer: Uint8Array): boolean {
  const field = utf8.decode(buffer.subarray(148, 154)).replace(/\0.*$/, '').trim()
  const readSum = Number.parseInt(field, 8)
  if (Number.isNaN(readSum)) return false
  let sum = 8 * 0x20
  for (let index = 0; index < 148; index++) sum += buffer[index] ?? 0
  for (let index = 156; index < 512; index++) sum += buffer[index] ?? 0
  return readSum === sum
}

/**
 * A read position over the bytes, with the semantics of `strtok3`'s buffer
 * tokenizer: a short read throws, a skip past the end stops at the end.
 */
class Cursor {
  position = 0
  readonly size: number
  readonly #bytes: Uint8Array
  #copied = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    this.size = bytes.length
  }

  #charge(count: number): void {
    this.#copied += count
    if (this.#copied > READ_BUDGET) throw new HardLimit()
  }

  /** Copy up to `length` bytes at `at` into `target`; how many were there. */
  peekInto(target: Uint8Array, length: number, mayBeLess: boolean, at = this.position): number {
    const count = Math.min(this.size - at, length)
    if (!mayBeLess && count < length) throw new EndOfInput()
    if (count > 0) {
      this.#charge(count)
      target.set(this.#bytes.subarray(at, at + count))
    }
    return count
  }

  peek(length: number): Uint8Array {
    const target = new Uint8Array(length)
    this.peekInto(target, length, false)
    return target
  }

  read(length: number): Uint8Array {
    const target = this.peek(length)
    this.position += length
    return target
  }

  /** Skip forward; past the end it stops at the end, as upstream. */
  ignore(length: number): void {
    const left = this.size - this.position
    this.position += Math.min(length, left)
  }

  safeIgnore(length: number, maximum: number): void {
    this.ignore(safeBound(length, maximum))
  }

  readU16(bigEndian: boolean): number {
    const bytes = this.read(2)
    return bigEndian ? u16be(bytes, 0) : u16le(bytes, 0)
  }

  /** The bytes from the position on, as a view: not copied, so not charged. */
  rest(): Uint8Array {
    return this.#bytes.subarray(this.position)
  }

  peekU32LE(): number {
    return u32le(this.peek(4), 0)
  }
}

/** The sniffer itself: one per detection, since it carries the cursor. */
class Detector {
  #buffer = new Uint8Array(SAMPLE)
  readonly #cursor: Cursor
  #reentry = 0
  readonly #insideGzip: boolean

  constructor(bytes: Uint8Array, insideGzip: boolean) {
    this.#cursor = new Cursor(bytes)
    this.#insideGzip = insideGzip
  }

  /** Every detector in turn, as `file-type`'s `parseTokenizer`. */
  async parse(reentry = 0): Promise<Found> {
    this.#reentry = reentry
    const initial = this.#cursor.position
    try {
      const confident = await this.#confident()
      if (confident) return confident
      if (this.#cursor.position !== initial) return undefined
      return this.#imprecise()
    } catch {
      // Upstream returns nothing on a short read or a size limit and throws on
      // anything else; nothing here is worth failing an upload over.
      return undefined
    }
  }

  #check(header: readonly number[], offset = 0, mask?: readonly number[]): boolean {
    return checkBytes(this.#buffer, header, offset, mask)
  }

  #checkString(text: string, offset = 0, encoding?: 'utf-16le' | 'utf-16be'): boolean {
    return this.#check(stringToBytes(text, encoding), offset)
  }

  #sample(length: number): void {
    this.#cursor.peekInto(this.#buffer, Math.min(length, this.#cursor.size), true)
  }

  async #confident(): Promise<Found> {
    const cursor = this.#cursor
    this.#buffer = new Uint8Array(SAMPLE)
    this.#sample(32)

    // -- 2-byte signatures --
    if (this.#check([0x42, 0x4d])) return found('bmp', 'image/bmp')
    if (this.#check([0x0b, 0x77])) return found('ac3', 'audio/vnd.dolby.dd-raw')
    if (this.#check([0x78, 0x01])) return found('dmg', 'application/x-apple-diskimage')
    if (this.#check([0x4d, 0x5a])) return found('exe', 'application/x-msdownload')
    if (this.#check([0x25, 0x21])) {
      this.#sample(24)
      if (this.#checkString('PS-Adobe-', 2) && this.#checkString(' EPSF-', 14)) {
        return found('eps', 'application/eps')
      }
      return found('ps', 'application/postscript')
    }
    if (this.#check([0x1f, 0xa0]) || this.#check([0x1f, 0x9d])) {
      return found('Z', 'application/x-compress')
    }
    if (this.#check([0xc7, 0x71])) return found('cpio', 'application/x-cpio')
    if (this.#check([0x60, 0xea])) return found('arj', 'application/x-arj')

    // -- 3-byte signatures --
    if (this.#check([0xef, 0xbb, 0xbf])) {
      // UTF-8 BOM: look again past it, without the imprecise pass.
      if (this.#reentry >= MAXIMUM_REENTRY) return undefined
      this.#reentry++
      cursor.ignore(3)
      return this.#confident()
    }
    if (this.#check([0x47, 0x49, 0x46])) return found('gif', 'image/gif')
    if (this.#check([0x49, 0x49, 0xbc])) return found('jxr', 'image/vnd.ms-photo')
    if (this.#check([0x1f, 0x8b, 0x8])) return this.#gzip()
    if (this.#check([0x42, 0x5a, 0x68])) return found('bz2', 'application/x-bzip2')
    if (this.#checkString('ID3')) {
      cursor.safeIgnore(6, 6)
      const sizeBytes = cursor.read(4)
      const headerLength =
        ((sizeBytes[3] ?? 0) & 0x7f) |
        (((sizeBytes[2] ?? 0) & 0x7f) << 7) |
        (((sizeBytes[1] ?? 0) & 0x7f) << 14) |
        (((sizeBytes[0] ?? 0) & 0x7f) << 21)
      if (cursor.position + headerLength > cursor.size) return found('mp3', 'audio/mpeg')
      cursor.safeIgnore(headerLength, cursor.size)
      if (this.#reentry >= MAXIMUM_REENTRY) return undefined
      this.#reentry++
      return this.parse(this.#reentry)
    }
    if (this.#checkString('MP+')) return found('mpc', 'audio/x-musepack')
    if ((this.#buffer[0] === 0x43 || this.#buffer[0] === 0x46) && this.#check([0x57, 0x53], 1)) {
      return found('swf', 'application/x-shockwave-flash')
    }

    // -- 4-byte signatures --
    if (this.#check([0xff, 0xd8, 0xff])) {
      if (this.#check([0xf7], 3)) return found('jls', 'image/jls')
      return found('jpg', 'image/jpeg')
    }
    if (this.#check([0x4f, 0x62, 0x6a, 0x01])) return found('avro', 'application/avro')
    if (this.#checkString('FLIF')) return found('flif', 'image/flif')
    if (this.#checkString('8BPS')) return found('psd', 'image/vnd.adobe.photoshop')
    if (this.#checkString('MPCK')) return found('mpc', 'audio/x-musepack')
    if (this.#checkString('FORM')) return found('aif', 'audio/aiff')
    if (this.#checkString('icns')) return found('icns', 'image/icns')
    if (this.#check([0x50, 0x4b, 0x3, 0x4])) return this.#zip()
    if (this.#checkString('OggS')) {
      cursor.ignore(28)
      const type = cursor.read(8)
      if (checkBytes(type, [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])) {
        return found('opus', 'audio/ogg; codecs=opus')
      }
      if (checkBytes(type, [0x80, 0x74, 0x68, 0x65, 0x6f, 0x72, 0x61])) {
        return found('ogv', 'video/ogg')
      }
      if (checkBytes(type, [0x01, 0x76, 0x69, 0x64, 0x65, 0x6f, 0x00])) {
        return found('ogm', 'video/ogg')
      }
      if (checkBytes(type, [0x7f, 0x46, 0x4c, 0x41, 0x43])) return found('oga', 'audio/ogg')
      if (checkBytes(type, [0x53, 0x70, 0x65, 0x65, 0x78, 0x20, 0x20])) {
        return found('spx', 'audio/ogg')
      }
      if (checkBytes(type, [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])) {
        return found('ogg', 'audio/ogg')
      }
      return found('ogx', 'application/ogg')
    }
    if (
      this.#check([0x50, 0x4b]) &&
      (this.#buffer[2] === 0x3 || this.#buffer[2] === 0x5 || this.#buffer[2] === 0x7) &&
      (this.#buffer[3] === 0x4 || this.#buffer[3] === 0x6 || this.#buffer[3] === 0x8)
    ) {
      return found('zip', 'application/zip')
    }
    if (this.#checkString('MThd')) return found('mid', 'audio/midi')
    if (
      this.#checkString('wOFF') &&
      (this.#check([0x00, 0x01, 0x00, 0x00], 4) || this.#checkString('OTTO', 4))
    ) {
      return found('woff', 'font/woff')
    }
    if (
      this.#checkString('wOF2') &&
      (this.#check([0x00, 0x01, 0x00, 0x00], 4) || this.#checkString('OTTO', 4))
    ) {
      return found('woff2', 'font/woff2')
    }
    if (this.#check([0xd4, 0xc3, 0xb2, 0xa1]) || this.#check([0xa1, 0xb2, 0xc3, 0xd4])) {
      return found('pcap', 'application/vnd.tcpdump.pcap')
    }
    if (this.#checkString('DSD ')) return found('dsf', 'audio/x-dsf')
    if (this.#checkString('LZIP')) return found('lz', 'application/lzip')
    if (this.#checkString('fLaC')) return found('flac', 'audio/flac')
    if (this.#check([0x42, 0x50, 0x47, 0xfb])) return found('bpg', 'image/bpg')
    if (this.#checkString('wvpk')) return found('wv', 'audio/wavpack')
    if (this.#checkString('%PDF')) return found('pdf', 'application/pdf')
    if (this.#check([0x00, 0x61, 0x73, 0x6d])) return found('wasm', 'application/wasm')
    if (this.#check([0x49, 0x49])) {
      const tiff = this.#tiff(false)
      if (tiff) return tiff
    }
    if (this.#check([0x4d, 0x4d])) {
      const tiff = this.#tiff(true)
      if (tiff) return tiff
    }
    if (this.#checkString('MAC ')) return found('ape', 'audio/ape')
    if (this.#check([0x1a, 0x45, 0xdf, 0xa3])) return this.#ebml()
    if (this.#checkString('SQLi')) return found('sqlite', 'application/x-sqlite3')
    if (this.#check([0x4e, 0x45, 0x53, 0x1a])) return found('nes', 'application/x-nintendo-nes-rom')
    if (this.#checkString('Cr24')) return found('crx', 'application/x-google-chrome-extension')
    if (this.#checkString('MSCF') || this.#checkString('ISc(')) {
      return found('cab', 'application/vnd.ms-cab-compressed')
    }
    if (this.#check([0xed, 0xab, 0xee, 0xdb])) return found('rpm', 'application/x-rpm')
    if (this.#check([0xc5, 0xd0, 0xd3, 0xc6])) return found('eps', 'application/eps')
    if (this.#check([0x28, 0xb5, 0x2f, 0xfd])) return found('zst', 'application/zstd')
    if (this.#check([0x7f, 0x45, 0x4c, 0x46])) return found('elf', 'application/x-elf')
    if (this.#check([0x21, 0x42, 0x44, 0x4e])) return found('pst', 'application/vnd.ms-outlook')
    if (this.#checkString('PAR1') || this.#checkString('PARE')) {
      return found('parquet', 'application/vnd.apache.parquet')
    }
    if (this.#checkString('ttcf')) return found('ttc', 'font/collection')
    if (
      this.#check([0xfe, 0xed, 0xfa, 0xce]) ||
      this.#check([0xfe, 0xed, 0xfa, 0xcf]) ||
      this.#check([0xce, 0xfa, 0xed, 0xfe]) ||
      this.#check([0xcf, 0xfa, 0xed, 0xfe])
    ) {
      return found('macho', 'application/x-mach-binary')
    }
    if (this.#check([0x04, 0x22, 0x4d, 0x18])) return found('lz4', 'application/x-lz4')
    if (this.#checkString('regf')) return found('dat', 'application/x-ft-windows-registry-hive')
    if (this.#checkString('$FL2') || this.#checkString('$FL3')) {
      return found('sav', 'application/x-spss-sav')
    }

    // -- 5-byte signatures --
    if (this.#check([0x4f, 0x54, 0x54, 0x4f, 0x00])) return found('otf', 'font/otf')
    if (this.#checkString('#!AMR')) return found('amr', 'audio/amr')
    if (this.#checkString('{\\rtf')) return found('rtf', 'application/rtf')
    if (this.#check([0x46, 0x4c, 0x56, 0x01])) return found('flv', 'video/x-flv')
    if (this.#checkString('IMPM')) return found('it', 'audio/x-it')
    if (
      ['-lh0-', '-lh1-', '-lh2-', '-lh3-', '-lh4-', '-lh5-', '-lh6-', '-lh7-'].some((tag) =>
        this.#checkString(tag, 2),
      ) ||
      ['-lzs-', '-lz4-', '-lz5-', '-lhd-'].some((tag) => this.#checkString(tag, 2))
    ) {
      return found('lzh', 'application/x-lzh-compressed')
    }
    if (this.#check([0x00, 0x00, 0x01, 0xba])) {
      if (this.#check([0x21], 4, [0xf1])) return found('mpg', 'video/MP1S')
      if (this.#check([0x44], 4, [0xc4])) return found('mpg', 'video/MP2P')
    }
    if (this.#checkString('ITSF')) return found('chm', 'application/vnd.ms-htmlhelp')
    if (this.#check([0xca, 0xfe, 0xba, 0xbe])) {
      // Java bytecode and Mach-O universal binaries share the magic number.
      const architectures = u32be(this.#buffer, 4)
      const javaMajor = u16be(this.#buffer, 6)
      if (architectures > 0 && architectures <= 30) {
        return found('macho', 'application/x-mach-binary')
      }
      if (javaMajor > 30) return found('class', 'application/java-vm')
    }
    if (this.#checkString('.RMF')) return found('rm', 'application/vnd.rn-realmedia')
    if (this.#checkString('DRACO')) return found('drc', 'application/x-ft-draco')

    // -- 6-byte signatures --
    if (this.#check([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return found('xz', 'application/x-xz')
    if (this.#checkString('<?xml ')) return found('xml', 'application/xml')
    if (this.#check([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
      return found('7z', 'application/x-7z-compressed')
    }
    if (
      this.#check([0x52, 0x61, 0x72, 0x21, 0x1a, 0x7]) &&
      (this.#buffer[6] === 0x0 || this.#buffer[6] === 0x1)
    ) {
      return found('rar', 'application/x-rar-compressed')
    }
    if (this.#checkString('solid ')) return found('stl', 'model/stl')
    if (this.#checkString('AC')) {
      const version = latin1(this.#buffer.subarray(2, 6))
      const numeric = Number(version)
      if (/^\d+$/.test(version) && numeric >= 1000 && numeric <= 1050) {
        return found('dwg', 'image/vnd.dwg')
      }
    }
    if (this.#checkString('070707')) return found('cpio', 'application/x-cpio')

    // -- 7-byte signatures --
    if (this.#checkString('BLENDER')) return found('blend', 'application/x-blender')
    if (this.#checkString('!<arch>')) {
      cursor.ignore(8)
      if (ascii(cursor.read(13)) === 'debian-binary') return found('deb', 'application/x-deb')
      return found('ar', 'application/x-unix-archive')
    }
    if (
      this.#checkString('WEBVTT') &&
      ['\n', '\r', '\t', ' ', '\0'].some((next) => this.#checkString(next, 6))
    ) {
      return found('vtt', 'text/vtt')
    }

    // -- 8-byte signatures --
    if (this.#check([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return this.#png()
    if (this.#check([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31, 0x00, 0x00])) {
      return found('arrow', 'application/vnd.apache.arrow.file')
    }
    if (this.#check([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00])) {
      return found('glb', 'model/gltf-binary')
    }
    if (
      this.#check([0x66, 0x72, 0x65, 0x65], 4) ||
      this.#check([0x6d, 0x64, 0x61, 0x74], 4) ||
      this.#check([0x6d, 0x6f, 0x6f, 0x76], 4) ||
      this.#check([0x77, 0x69, 0x64, 0x65], 4)
    ) {
      return found('mov', 'video/quicktime')
    }

    // -- 9-byte signatures --
    if (this.#check([0x49, 0x49, 0x52, 0x4f, 0x08, 0x00, 0x00, 0x00, 0x18])) {
      return found('orf', 'image/x-olympus-orf')
    }
    if (this.#checkString('gimp xcf ')) return found('xcf', 'image/x-xcf')
    if (this.#checkString('ftyp', 4) && ((this.#buffer[8] ?? 0) & 0x60) !== 0x00) {
      return isoBrand(latin1(this.#buffer.subarray(8, 12)).replace('\0', ' ').trim())
    }

    // -- 10-byte signatures --
    if (this.#checkString('REGEDIT4\r\n')) return found('reg', 'application/x-ms-regedit')

    // -- 12-byte signatures --
    if (this.#check([0x52, 0x49, 0x46, 0x46])) {
      if (this.#checkString('WEBP', 8)) return found('webp', 'image/webp')
      if (this.#check([0x41, 0x56, 0x49], 8)) return found('avi', 'video/vnd.avi')
      if (this.#check([0x57, 0x41, 0x56, 0x45], 8)) return found('wav', 'audio/wav')
      if (this.#check([0x51, 0x4c, 0x43, 0x4d], 8)) return found('qcp', 'audio/qcelp')
    }
    if (this.#check([0x49, 0x49, 0x55, 0x00, 0x18, 0x00, 0x00, 0x00, 0x88, 0xe7, 0x74, 0xd8])) {
      return found('rw2', 'image/x-panasonic-rw2')
    }
    if (this.#check([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9])) {
      return this.#asf()
    }
    if (this.#check([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return found('ktx', 'image/ktx')
    }
    if (
      (this.#check([0x7e, 0x10, 0x04]) || this.#check([0x7e, 0x18, 0x04])) &&
      this.#check([0x30, 0x4d, 0x49, 0x45], 4)
    ) {
      return found('mie', 'application/x-mie')
    }
    if (this.#check([0x27, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 2)) {
      return found('shp', 'application/x-esri-shape')
    }
    if (this.#check([0xff, 0x4f, 0xff, 0x51])) return found('j2c', 'image/j2c')
    if (this.#check([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) {
      cursor.ignore(20)
      switch (ascii(cursor.read(4))) {
        case 'jp2 ':
          return found('jp2', 'image/jp2')
        case 'jpx ':
          return found('jpx', 'image/jpx')
        case 'jpm ':
          return found('jpm', 'image/jpm')
        case 'mjp2':
          return found('mj2', 'image/mj2')
        default:
          return undefined
      }
    }
    if (
      this.#check([0xff, 0x0a]) ||
      this.#check([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
    ) {
      return found('jxl', 'image/jxl')
    }
    if (this.#check([0xfe, 0xff])) {
      // UTF-16 BE BOM: XML, or some text this cannot name.
      if (this.#checkString('<?xml ', 2, 'utf-16be')) return found('xml', 'application/xml')
      return undefined
    }
    if (this.#check([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      return found('cfb', 'application/x-cfb')
    }

    this.#sample(256)
    if (this.#check([0x61, 0x63, 0x73, 0x70], 36)) return found('icc', 'application/vnd.iccprofile')
    if (this.#checkString('**ACE', 7) && this.#checkString('**', 12)) {
      return found('ace', 'application/x-ace-compressed')
    }

    // -- 15-byte signatures --
    if (this.#checkString('BEGIN:')) {
      if (this.#checkString('VCARD', 6)) return found('vcf', 'text/vcard')
      if (this.#checkString('VCALENDAR', 6)) return found('ics', 'text/calendar')
    }
    if (this.#checkString('FUJIFILMCCD-RAW')) return found('raf', 'image/x-fujifilm-raf')
    if (this.#checkString('Extended Module:')) return found('xm', 'audio/x-xm')
    if (this.#checkString('Creative Voice File')) return found('voc', 'audio/x-voc')
    if (this.#check([0x04, 0x00, 0x00, 0x00]) && isAsar(this.#buffer)) {
      return found('asar', 'application/x-asar')
    }
    if (
      this.#check([
        0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0d, 0x01, 0x02, 0x01, 0x01, 0x02,
      ])
    ) {
      return found('mxf', 'application/mxf')
    }
    if (this.#checkString('SCRM', 44)) return found('s3m', 'audio/x-s3m')
    if (this.#check([0x47]) && this.#check([0x47], 188)) return found('mts', 'video/mp2t')
    if (this.#check([0x47], 4) && this.#check([0x47], 196)) return found('mts', 'video/mp2t')
    if (this.#check([0x42, 0x4f, 0x4f, 0x4b, 0x4d, 0x4f, 0x42, 0x49], 60)) {
      return found('mobi', 'application/x-mobipocket-ebook')
    }
    if (this.#check([0x44, 0x49, 0x43, 0x4d], 128)) return found('dcm', 'application/dicom')
    if (
      this.#check([
        0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x46,
      ])
    ) {
      return found('lnk', 'application/x-ms-shortcut')
    }
    if (
      this.#check([
        0x62, 0x6f, 0x6f, 0x6b, 0x00, 0x00, 0x00, 0x00, 0x6d, 0x61, 0x72, 0x6b, 0x00, 0x00, 0x00,
        0x00,
      ])
    ) {
      return found('alias', 'application/x-ft-apple.alias')
    }
    if (this.#checkString('Kaydara FBX Binary  \u0000')) return found('fbx', 'application/x-ft-fbx')
    if (
      this.#check([0x4c, 0x50], 34) &&
      (this.#check([0x00, 0x00, 0x01], 8) ||
        this.#check([0x01, 0x00, 0x02], 8) ||
        this.#check([0x02, 0x00, 0x02], 8))
    ) {
      return found('eot', 'application/vnd.ms-fontobject')
    }
    if (
      this.#check([
        0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7,
        0x1d,
      ])
    ) {
      return found('indd', 'application/x-indesign')
    }

    // -- 16-byte signatures --
    if (
      this.#check([
        0xff, 0xff, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
        0x00,
      ]) ||
      this.#check([
        0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01, 0x00,
        0x01,
      ])
    ) {
      return found('jmp', 'application/x-jmp-data')
    }

    this.#sample(512)
    if (
      (this.#checkString('ustar', 257) &&
        (this.#checkString('\0', 262) || this.#checkString(' ', 262))) ||
      (this.#check([0, 0, 0, 0, 0, 0], 257) && tarChecksumMatches(this.#buffer))
    ) {
      return found('tar', 'application/x-tar')
    }
    if (this.#check([0xff, 0xfe])) {
      // UTF-16 LE BOM.
      if (this.#checkString('<?xml ', 2, 'utf-16le')) return found('xml', 'application/xml')
      if (this.#check([0xff, 0x0e], 2) && this.#checkString('SketchUp Model', 4, 'utf-16le')) {
        return found('skp', 'application/vnd.sketchup.skp')
      }
      if (this.#checkString('Windows Registry Editor Version 5.00\r\n', 2, 'utf-16le')) {
        return found('reg', 'application/x-ms-regedit')
      }
      return undefined
    }
    if (this.#checkString('-----BEGIN PGP MESSAGE-----')) {
      return found('pgp', 'application/pgp-encrypted')
    }
    return undefined
  }

  /** Signatures with little to go on, tried only when nothing else matched. */
  #imprecise(): Found {
    this.#buffer = new Uint8Array(SAMPLE)
    this.#sample(8)
    if (this.#check([0x0, 0x0, 0x1, 0xba]) || this.#check([0x0, 0x0, 0x1, 0xb3])) {
      return found('mpg', 'video/mpeg')
    }
    if (this.#check([0x00, 0x01, 0x00, 0x00, 0x00])) return found('ttf', 'font/ttf')
    if (this.#check([0x00, 0x00, 0x01, 0x00])) return found('ico', 'image/x-icon')
    if (this.#check([0x00, 0x00, 0x02, 0x00])) return found('cur', 'image/x-icon')
    this.#sample(4)
    return this.#mpegFrame()
  }

  /** An MPEG audio frame header (or ADTS) at the very start. */
  #mpegFrame(): Found {
    if (!this.#check([0xff, 0xe0], 0, [0xff, 0xe0])) return undefined
    if (this.#check([0x10], 1, [0x16])) return found('aac', 'audio/aac')
    // MPEG-1 Layer I with CRC is byte-identical to a UTF-16 LE BOM.
    if (this.#check([0xff, 0xfe])) return undefined
    if (this.#check([0x08], 1, [0x18])) return undefined
    if (this.#check([0xf0], 2, [0xf0])) return undefined
    if (this.#check([0x0c], 2, [0x0c])) return undefined
    if (this.#check([0x02], 1, [0x06])) return found('mp3', 'audio/mpeg')
    if (this.#check([0x04], 1, [0x06])) return found('mp2', 'audio/mpeg')
    if (this.#check([0x06], 1, [0x06])) return found('mp1', 'audio/mpeg')
    return undefined
  }

  /** A gzip stream, and a tarball when that is what it holds. */
  async #gzip(): Promise<Found> {
    const gz = found('gz', 'application/gzip')
    if (this.#insideGzip) return gz
    let inner: Uint8Array
    try {
      inner = await decompressPrefix(this.#cursor.rest(), 'gzip', SAMPLE)
    } catch {
      return gz
    }
    const nested = await new Detector(inner, true).parse()
    return nested?.ext === 'tar' ? found('tar.gz', 'application/gzip') : gz
  }

  /** The TIFF family; `undefined` lets the remaining checks run. */
  #tiff(bigEndian: boolean): Found {
    const tif = found('tif', 'image/tiff')
    const read16 = bigEndian ? u16be : u16le
    const version = read16(this.#buffer, 2)
    const ifdOffset = (bigEndian ? u32be : u32le)(this.#buffer, 4)
    if (version === 42) {
      if (ifdOffset >= 6) {
        if (this.#checkString('CR', 8)) return found('cr2', 'image/x-canon-cr2')
        if (ifdOffset >= 8) {
          const first = read16(this.#buffer, 8)
          const second = read16(this.#buffer, 10)
          if ((first === 0x1c && second === 0xfe) || (first === 0x1f && second === 0x0b)) {
            return found('nef', 'image/x-nikon-nef')
          }
        }
      }
      const cursor = this.#cursor
      cursor.safeIgnore(ifdOffset, cursor.size)
      try {
        const tags = cursor.readU16(bigEndian)
        if (tags > MAXIMUM_TIFF_TAGS) return tif
        for (let tag = 0; tag < tags; tag++) {
          const id = cursor.readU16(bigEndian)
          cursor.ignore(10)
          if (id === 50_341) return found('arw', 'image/x-sony-arw')
          if (id === 50_706) return found('dng', 'image/x-adobe-dng')
        }
      } catch (error) {
        if (error instanceof EndOfInput) return undefined
        throw error
      }
      return tif
    }
    if (version === 43) return tif
    return undefined
  }

  /** PNG, or APNG when an animation control chunk comes before the image data. */
  #png(): Found {
    const png = found('png', 'image/png')
    const cursor = this.#cursor
    cursor.ignore(8)
    let chunks = 0
    let seenHeader = false
    do {
      chunks++
      if (chunks > MAXIMUM_PNG_CHUNKS) break
      const previous = cursor.position
      const lengthBytes = cursor.read(4)
      const length = u32be(lengthBytes, 0) | 0
      const type = latin1(cursor.read(4))
      if (length < 0) return undefined
      if (type === 'IHDR') {
        if (length !== 13) return undefined
        seenHeader = true
      }
      if (type === 'IDAT') return png
      if (type === 'acTL') return found('apng', 'image/apng')
      if (!seenHeader && type !== 'CgBI') return undefined
      try {
        cursor.safeIgnore(length + 4, cursor.size)
      } catch (error) {
        if (error instanceof HardLimit) return png
        throw error
      }
      if (cursor.position <= previous) break
    } while (cursor.position + 8 < cursor.size)
    return png
  }

  /** Matroska or WebM, from the EBML header's DocType. */
  #ebml(): Found {
    const cursor = this.#cursor
    const readField = (): Uint8Array => {
      const first = cursor.peek(1)[0] ?? 0
      let mask = 0x80
      let extra = 0
      while ((first & mask) === 0 && mask !== 0) {
        extra++
        mask >>= 1
      }
      return cursor.read(extra + 1)
    }
    const readElement = (): { id: number; length: number } => {
      const id = readField()
      const length = readField()
      length[0] = (length[0] ?? 0) ^ (0x80 >> (length.length - 1))
      return {
        id: uintBE(id, 0, id.length),
        length: uintBE(
          length,
          length.length - Math.min(6, length.length),
          Math.min(6, length.length),
        ),
      }
    }
    const root = readElement()
    let documentType: string | undefined
    let children = root.length
    let elements = 0
    while (children > 0) {
      elements++
      if (elements > MAXIMUM_EBML_ELEMENTS) break
      const previous = cursor.position
      const element = readElement()
      if (element.id === 0x4282) {
        if (element.length > MAXIMUM_EBML_DOCTYPE) break
        documentType = utf8
          .decode(cursor.read(safeBound(element.length, MAXIMUM_EBML_DOCTYPE)))
          .replaceAll(/\0.*$/g, '')
        break
      }
      cursor.safeIgnore(element.length, cursor.size)
      children--
      if (cursor.position <= previous) break
    }
    if (documentType === 'webm') return found('webm', 'video/webm')
    if (documentType === 'matroska') return found('mkv', 'video/matroska')
    return undefined
  }

  /** Windows Media (ASF): audio, video or generic, from the stream properties. */
  #asf(): Found {
    const cursor = this.#cursor
    try {
      cursor.safeIgnore(30, 30)
      let objects = 0
      while (cursor.position + 24 < cursor.size) {
        objects++
        if (objects > MAXIMUM_ASF_OBJECTS) break
        const previous = cursor.position
        const guid = cursor.read(16)
        const sizeBytes = cursor.read(8)
        const size = u32le(sizeBytes, 0) + u32le(sizeBytes, 4) * 2 ** 32
        let payload = size - 24
        if (!Number.isFinite(payload) || payload < 0) return undefined
        if (
          checkBytes(
            guid,
            [
              0x91, 0x07, 0xdc, 0xb7, 0xb7, 0xa9, 0xcf, 0x11, 0x8e, 0xe6, 0x00, 0xc0, 0x0c, 0x20,
              0x53, 0x65,
            ],
          )
        ) {
          const typeId = cursor.read(16)
          payload -= 16
          if (
            checkBytes(
              typeId,
              [
                0x40, 0x9e, 0x69, 0xf8, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c,
                0x44, 0x2b,
              ],
            )
          ) {
            return found('asf', 'audio/x-ms-asf')
          }
          if (
            checkBytes(
              typeId,
              [
                0xc0, 0xef, 0x19, 0xbc, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c,
                0x44, 0x2b,
              ],
            )
          ) {
            return found('asf', 'video/x-ms-asf')
          }
          break
        }
        cursor.safeIgnore(payload, cursor.size)
        if (cursor.position <= previous) return undefined
      }
    } catch (error) {
      if (!(error instanceof EndOfInput || error instanceof HardLimit)) throw error
    }
    return found('asf', 'application/vnd.ms-asf')
  }

  /** A ZIP archive and the formats built on one (OOXML, ODF, EPUB, iWork, JAR…). */
  async #zip(): Promise<Found> {
    const cursor = this.#cursor
    const openXml = {
      hasContentTypes: false,
      parsedContentTypes: false,
      parsingContentTypes: false,
      unparseableContentTypes: false,
      word: false,
      presentation: false,
      spreadsheet: false,
      threeDimensionalModel: false,
    }
    const iWork = { document: false, masterSlide: false, tables: false }
    let fileType: Found
    let descriptorBytes = 0

    const fromDirectories = (): Found => {
      if (openXml.word) return found('docx', OOXML_DOCUMENT)
      if (openXml.presentation) return found('pptx', OOXML_PRESENTATION)
      if (openXml.spreadsheet) return found('xlsx', OOXML_SHEET)
      if (openXml.threeDimensionalModel) return found('3mf', 'model/3mf')
      return undefined
    }
    const fromEntries = (): Found => {
      if (
        !openXml.hasContentTypes ||
        openXml.unparseableContentTypes ||
        openXml.parsingContentTypes ||
        openXml.parsedContentTypes
      ) {
        return undefined
      }
      return fromDirectories()
    }
    const fromIWork = (): Found => {
      if (!iWork.document) return undefined
      if (iWork.masterSlide) return found('key', 'application/vnd.apple.keynote')
      if (iWork.tables) return found('numbers', 'application/vnd.apple.numbers')
      return found('pages', 'application/vnd.apple.pages')
    }

    type Handler = (data: Uint8Array) => void
    const onEntry = (entry: ZipEntry): { stop?: boolean; handler?: Handler } => {
      const name = entry.filename
      if (name.startsWith('word/')) openXml.word = true
      if (name.startsWith('ppt/')) openXml.presentation = true
      if (name.startsWith('xl/')) openXml.spreadsheet = true
      if (name.startsWith('3D/') && name.endsWith('.model')) openXml.threeDimensionalModel = true
      if (name === 'Index/Document.iwa') iWork.document = true
      if (name.startsWith('Index/MasterSlide')) iWork.masterSlide = true
      if (name.startsWith('Index/Tables/')) iWork.tables = true
      if (iWork.document && (iWork.masterSlide || iWork.tables)) {
        fileType = fromIWork()
        return { stop: true }
      }
      const isContentTypes = name === '[Content_Types].xml'
      const entries = fromEntries()
      if (!isContentTypes && entries) {
        fileType = entries
        return { stop: true }
      }
      switch (name) {
        case 'META-INF/mozilla.rsa':
          fileType = found('xpi', 'application/x-xpinstall')
          return { stop: true }
        case 'META-INF/MANIFEST.MF':
          fileType = found('jar', 'application/java-archive')
          return { stop: true }
        case 'mimetype':
          if (!readableForDetection(entry)) return {}
          return {
            handler: (data) => {
              fileType = fromMimeType(utf8.decode(data).trim())
            },
            stop: true,
          }
        case '[Content_Types].xml':
          openXml.hasContentTypes = true
          if (!readableForDetection(entry)) {
            openXml.unparseableContentTypes = true
            return {}
          }
          openXml.parsingContentTypes = true
          return {
            handler: (data) => {
              const mimeType = mainContentType(utf8.decode(data))
              if (mimeType) fileType = fromMimeType(mimeType)
              openXml.parsedContentTypes = true
              openXml.parsingContentTypes = false
            },
            stop: true,
          }
        default:
          if (/classes\d*\.dex/.test(name)) {
            fileType = found('apk', 'application/vnd.android.package-archive')
            return { stop: true }
          }
          return {}
      }
    }

    /** Entry data of unknown size: up to the data descriptor that closes it. */
    const readUntilDescriptor = (buffer: boolean, maximum: number): Uint8Array | undefined => {
      const sync = new Uint8Array(ZIP_SYNC_BUFFER)
      const parts: Uint8Array[] = []
      let consumed = 0
      for (;;) {
        const length = cursor.peekInto(sync, ZIP_SYNC_BUFFER, true)
        const window = sync.subarray(0, length)
        const at = findDataDescriptor(window, consumed)
        const retained = at >= 0 ? 0 : length === ZIP_SYNC_BUFFER ? Math.min(15, length - 1) : 0
        const chunk = at >= 0 ? at : length - retained
        if (chunk === 0) break
        consumed += chunk
        if (consumed > maximum) throw new ZipProblem('ZIP entry compressed data exceeds the limit')
        if (buffer) parts.push(cursor.read(chunk))
        else cursor.ignore(chunk)
        if (at >= 0) break
      }
      descriptorBytes += consumed
      return buffer ? concat(parts, consumed) : undefined
    }

    const readEntryData = (
      entry: ZipEntry,
      buffer: boolean,
      maximumDescriptor: number,
    ): Uint8Array | undefined => {
      if (entry.dataDescriptor && entry.compressedSize === 0) {
        return readUntilDescriptor(buffer, maximumDescriptor)
      }
      if (!buffer) {
        cursor.safeIgnore(entry.compressedSize, cursor.size)
        return undefined
      }
      const maximum = Math.min(
        Math.max(0, cursor.size - cursor.position),
        MAXIMUM_ZIP_BUFFERED_READ,
      )
      if (entry.compressedSize < 0 || entry.compressedSize > maximum) {
        throw new ZipProblem('ZIP entry compressed data exceeds the limit')
      }
      return cursor.read(entry.compressedSize)
    }

    try {
      let entries = 0
      let stop = false
      do {
        const entry = readLocalFileHeader(cursor)
        if (!entry) break
        entries++
        if (entries > MAXIMUM_ZIP_ENTRIES) throw new ZipProblem('ZIP entry count exceeds the limit')
        const next = onEntry(entry)
        stop = next.stop === true
        cursor.ignore(entry.extraFieldLength)
        const data = readEntryData(
          entry,
          next.handler !== undefined,
          Math.min(MAXIMUM_ZIP_ENTRY, Math.max(0, MAXIMUM_ZIP_ENTRY - descriptorBytes)),
        )
        if (next.handler) {
          next.handler(await inflateEntry(entry, data ?? new Uint8Array(0)))
        }
        if (entry.dataDescriptor && u32le(cursor.read(16), 0) !== ZIP_DATA_DESCRIPTOR) {
          throw new ZipProblem('Expected data-descriptor-signature')
        }
      } while (!stop)
    } catch (error) {
      if (openXml.parsingContentTypes) {
        openXml.parsingContentTypes = false
        openXml.unparseableContentTypes = true
      }
      // Truncated before [Content_Types].xml: LibreOffice writes it last.
      if (!fileType && error instanceof EndOfInput && !openXml.hasContentTypes) {
        fileType = fromDirectories()
      }
    }
    return fileType ?? fromEntries() ?? fromIWork() ?? found('zip', 'application/zip')
  }
}

const OOXML_DOCUMENT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const OOXML_PRESENTATION =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const OOXML_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

interface ZipEntry {
  readonly filename: string
  readonly dataDescriptor: boolean
  readonly compressedMethod: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly extraFieldLength: number
}

function readLocalFileHeader(cursor: Cursor): ZipEntry | false {
  const signature = cursor.peekU32LE()
  if (signature === ZIP_LOCAL_FILE_HEADER) {
    const header = cursor.read(30)
    const filenameLength = u16le(header, 26)
    return {
      dataDescriptor: (u16le(header, 6) & 0x0008) !== 0,
      compressedMethod: u16le(header, 8),
      compressedSize: u32le(header, 18),
      uncompressedSize: u32le(header, 22),
      extraFieldLength: u16le(header, 28),
      filename: utf8.decode(cursor.read(filenameLength)),
    }
  }
  if (signature === ZIP_CENTRAL_FILE_HEADER) return false
  if (signature === ZIP_ENCRYPTED) throw new ZipProblem('Encrypted ZIP')
  throw new ZipProblem('Unexpected signature')
}

function readableForDetection(entry: ZipEntry): boolean {
  return [entry.compressedSize, entry.uncompressedSize].every(
    (size) => Number.isFinite(size) && size >= 0 && size <= MAXIMUM_ZIP_ENTRY,
  )
}

function findDataDescriptor(buffer: Uint8Array, consumed: number): number {
  if (buffer.length < 16) return -1
  for (let index = 0; index <= buffer.length - 16; index++) {
    if (
      u32le(buffer, index) === ZIP_DATA_DESCRIPTOR &&
      u32le(buffer, index + 8) === consumed + index
    ) {
      return index
    }
  }
  return -1
}

async function inflateEntry(entry: ZipEntry, data: Uint8Array): Promise<Uint8Array> {
  if (entry.compressedMethod === 0) return data
  if (entry.compressedMethod !== 8) throw new ZipProblem('Unsupported ZIP compression method')
  return decompress(data, 'deflate-raw', MAXIMUM_ZIP_ENTRY)
}

/** The `ContentType="….main+xml"` value of an OOXML [Content_Types].xml. */
function mainContentType(xml: string): string | undefined {
  const end = xml.indexOf('.main+xml"')
  if (end === -1) {
    const model = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
    return xml.includes(`ContentType="${model}"`) ? model : undefined
  }
  const truncated = xml.slice(0, end)
  return truncated.slice(truncated.lastIndexOf('"') + 1)
}

function fromMimeType(declared: string): Found {
  const mimeType = declared.toLowerCase()
  switch (mimeType) {
    case 'application/epub+zip':
      return found('epub', mimeType)
    case 'application/vnd.oasis.opendocument.text':
      return found('odt', mimeType)
    case 'application/vnd.oasis.opendocument.text-template':
      return found('ott', mimeType)
    case 'application/vnd.oasis.opendocument.spreadsheet':
      return found('ods', mimeType)
    case 'application/vnd.oasis.opendocument.spreadsheet-template':
      return found('ots', mimeType)
    case 'application/vnd.oasis.opendocument.presentation':
      return found('odp', mimeType)
    case 'application/vnd.oasis.opendocument.presentation-template':
      return found('otp', mimeType)
    case 'application/vnd.oasis.opendocument.graphics':
      return found('odg', mimeType)
    case 'application/vnd.oasis.opendocument.graphics-template':
      return found('otg', mimeType)
    case 'application/vnd.openxmlformats-officedocument.presentationml.slideshow':
      return found('ppsx', mimeType)
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return found('xlsx', mimeType)
    case 'application/vnd.ms-excel.sheet.macroenabled':
      return found('xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12')
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.template':
      return found('xltx', mimeType)
    case 'application/vnd.ms-excel.template.macroenabled':
      return found('xltm', 'application/vnd.ms-excel.template.macroenabled.12')
    case 'application/vnd.ms-powerpoint.slideshow.macroenabled':
      return found('ppsm', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12')
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return found('docx', mimeType)
    case 'application/vnd.ms-word.document.macroenabled':
      return found('docm', 'application/vnd.ms-word.document.macroenabled.12')
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.template':
      return found('dotx', mimeType)
    case 'application/vnd.ms-word.template.macroenabledtemplate':
      return found('dotm', 'application/vnd.ms-word.template.macroenabled.12')
    case 'application/vnd.openxmlformats-officedocument.presentationml.template':
      return found('potx', mimeType)
    case 'application/vnd.ms-powerpoint.template.macroenabled':
      return found('potm', 'application/vnd.ms-powerpoint.template.macroenabled.12')
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return found('pptx', mimeType)
    case 'application/vnd.ms-powerpoint.presentation.macroenabled':
      return found('pptm', 'application/vnd.ms-powerpoint.presentation.macroenabled.12')
    case 'application/vnd.ms-visio.drawing':
      return found('vsdx', 'application/vnd.visio')
    case 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml':
      return found('3mf', 'model/3mf')
    default:
      return undefined
  }
}

/** The ISO base media brands (`ftyp` major brand) this names. */
function isoBrand(brand: string): SniffedFileType {
  switch (brand) {
    case 'avif':
    case 'avis':
      return found('avif', 'image/avif')
    case 'mif1':
      return found('heic', 'image/heif')
    case 'msf1':
      return found('heic', 'image/heif-sequence')
    case 'heic':
    case 'heix':
      return found('heic', 'image/heic')
    case 'hevc':
    case 'hevx':
      return found('heic', 'image/heic-sequence')
    case 'qt':
      return found('mov', 'video/quicktime')
    case 'M4V':
    case 'M4VH':
    case 'M4VP':
      return found('m4v', 'video/x-m4v')
    case 'M4P':
      return found('m4p', 'video/mp4')
    case 'M4B':
      return found('m4b', 'audio/mp4')
    case 'M4A':
      return found('m4a', 'audio/x-m4a')
    case 'F4V':
      return found('f4v', 'video/mp4')
    case 'F4P':
      return found('f4p', 'video/mp4')
    case 'F4A':
      return found('f4a', 'audio/mp4')
    case 'F4B':
      return found('f4b', 'audio/mp4')
    case 'crx':
      return found('cr3', 'image/x-canon-cr3')
    default:
      if (brand.startsWith('3g2')) return found('3g2', 'video/3gpp2')
      if (brand.startsWith('3g')) return found('3gp', 'video/3gpp')
      return found('mp4', 'video/mp4')
  }
}

/** Electron's ASAR: a Pickle whose JSON header lists `files`. */
function isAsar(buffer: Uint8Array): boolean {
  const jsonSize = u32le(buffer, 12)
  if (jsonSize <= 12 || buffer.length < jsonSize + 16) return false
  try {
    const header: unknown = JSON.parse(utf8.decode(buffer.subarray(16, jsonSize + 16)))
    return typeof header === 'object' && header !== null && Boolean(Reflect.get(header, 'files'))
  } catch {
    return false
  }
}

function uintBE(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0
  for (let index = offset; index < offset + length; index++) {
    value = value * 256 + (bytes[index] ?? 0)
  }
  return value
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** `bytes` as a stream of slices, so nothing is copied that is never read. */
// `ArrayBufferView | ArrayBuffer` is DOM's `BufferSource`, spelled out: a
// package that compiles these sources without the DOM lib (inker does) has
// no `BufferSource`, and a narrower chunk type does not fit
// `DecompressionStream`'s writable side under the DOM lib.
function streamOf(bytes: Uint8Array): ReadableStream<ArrayBufferView | ArrayBuffer> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(bytes.length, offset + 64 * 1024)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
}

/** Inflate `data` whole, refusing more than `maximum` bytes of output. */
async function decompress(
  data: Uint8Array,
  format: 'deflate-raw' | 'gzip',
  maximum: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  const reader = streamOf(data).pipeThrough(new DecompressionStream(format)).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maximum) {
        await reader.cancel().catch(() => {})
        throw new ZipProblem('ZIP entry decompressed data exceeds the limit')
      }
      parts.push(value)
    }
  } catch (error) {
    // An entry closed by a data descriptor can carry bytes after its deflate
    // stream; what was inflated before them is valid and enough, as upstream.
    if (errorCode(error) !== 'ERR_TRAILING_JUNK_AFTER_STREAM_END') throw error
  } finally {
    reader.releaseLock()
  }
  return concat(parts, total)
}

/** A tar header: what an inflated prefix must hold to be told apart. */
const TAR_HEADER = 512

/**
 * The first `length` inflated bytes of `data`, the rest left undecompressed.
 *
 * A stream that breaks off (a truncated upload) still answers when a whole
 * tar header came out before the break, as it does upstream, where the
 * nested detection reads what was inflated so far.
 */
async function decompressPrefix(
  data: Uint8Array,
  format: 'gzip',
  length: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  const reader = streamOf(data).pipeThrough(new DecompressionStream(format)).getReader()
  try {
    while (total < length) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      total += value.length
    }
  } catch (error) {
    if (total < TAR_HEADER) throw error
  } finally {
    await reader.cancel().catch(() => {})
  }
  return concat(parts, total).subarray(0, length)
}

/**
 * The real type of `bytes`, or `undefined` when they match no signature —
 * plain text (txt, csv, svg, json…) has none.
 */
export async function sniffFileType(bytes: Uint8Array): Promise<SniffedFileType | undefined> {
  if (bytes.length <= 1) return undefined
  return new Detector(bytes, false).parse()
}

/** Every extension {@link sniffFileType} can answer. */
export const sniffableExtensions: ReadonlySet<string> = new Set([
  '3g2',
  '3gp',
  '3mf',
  '7z',
  'aac',
  'ac3',
  'ace',
  'aif',
  'alias',
  'amr',
  'ape',
  'apk',
  'apng',
  'ar',
  'arj',
  'arrow',
  'arw',
  'asar',
  'asf',
  'avi',
  'avif',
  'avro',
  'blend',
  'bmp',
  'bpg',
  'bz2',
  'cab',
  'cfb',
  'chm',
  'class',
  'cpio',
  'cr2',
  'cr3',
  'crx',
  'cur',
  'dat',
  'dcm',
  'deb',
  'dmg',
  'dng',
  'docm',
  'docx',
  'dotm',
  'dotx',
  'drc',
  'dsf',
  'dwg',
  'elf',
  'eot',
  'eps',
  'epub',
  'exe',
  'f4a',
  'f4b',
  'f4p',
  'f4v',
  'fbx',
  'flac',
  'flif',
  'flv',
  'gif',
  'glb',
  'gz',
  'heic',
  'icc',
  'icns',
  'ico',
  'ics',
  'indd',
  'it',
  'j2c',
  'jar',
  'jls',
  'jmp',
  'jp2',
  'jpg',
  'jpm',
  'jpx',
  'jxl',
  'jxr',
  'key',
  'ktx',
  'lnk',
  'lz',
  'lz4',
  'lzh',
  'm4a',
  'm4b',
  'm4p',
  'm4v',
  'macho',
  'mid',
  'mie',
  'mj2',
  'mkv',
  'mobi',
  'mov',
  'mp1',
  'mp2',
  'mp3',
  'mp4',
  'mpc',
  'mpg',
  'mts',
  'mxf',
  'nef',
  'nes',
  'numbers',
  'odg',
  'odp',
  'ods',
  'odt',
  'oga',
  'ogg',
  'ogm',
  'ogv',
  'ogx',
  'opus',
  'orf',
  'otf',
  'otg',
  'otp',
  'ots',
  'ott',
  'pages',
  'parquet',
  'pcap',
  'pdf',
  'pgp',
  'png',
  'potm',
  'potx',
  'ppsm',
  'ppsx',
  'pptm',
  'pptx',
  'ps',
  'psd',
  'pst',
  'qcp',
  'raf',
  'rar',
  'reg',
  'rm',
  'rpm',
  'rtf',
  'rw2',
  's3m',
  'sav',
  'shp',
  'skp',
  'spx',
  'sqlite',
  'stl',
  'swf',
  'tar',
  'tar.gz',
  'tif',
  'ttc',
  'ttf',
  'vcf',
  'voc',
  'vsdx',
  'vtt',
  'wasm',
  'wav',
  'webm',
  'webp',
  'woff',
  'woff2',
  'wv',
  'xcf',
  'xlsm',
  'xlsx',
  'xltm',
  'xltx',
  'xm',
  'xml',
  'xpi',
  'xz',
  'Z',
  'zip',
  'zst',
])
