// ZIP STORE, UTF-8 filenames, CRC32. No remote libraries and no compression.
const encoder = new TextEncoder();
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[i] = c >>> 0;
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(files, date = new Date()) {
  if (files.length > 65535) throw new Error('Слишком много файлов для ZIP. ZIP64 не поддерживается.');
  const chunks = [], central = [];
  let offset = 0, centralSize = 0;
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2);
  const dosDate = (year - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate();
  for (const file of files) {
    if (file.name.startsWith('/') || file.name.split('/').some(part => part === '..') || file.name.includes('\\')) throw new Error('Некорректное имя файла ZIP');
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    if (name.length > 65535 || data.length >= 0xffffffff || offset + 30 + name.length + data.length >= 0xffffffff) throw new Error('Архив слишком велик. ZIP64 не поддерживается.');
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length), localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x800, true);
    localView.setUint16(10, dosTime, true); localView.setUint16(12, dosDate, true); localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true); localView.setUint32(22, data.length, true); localView.setUint16(26, name.length, true); local.set(name, 30);
    const record = new Uint8Array(46 + name.length), view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0x800, true);
    view.setUint16(12, dosTime, true); view.setUint16(14, dosDate, true); view.setUint32(16, crc, true);
    view.setUint32(20, data.length, true); view.setUint32(24, data.length, true); view.setUint16(28, name.length, true);
    view.setUint32(42, offset, true); record.set(name, 46);
    chunks.push(local, data); central.push(record); centralSize += record.length; offset += local.length + data.length;
  }
  if (offset + centralSize + 22 >= 0xffffffff) throw new Error('Архив слишком велик. ZIP64 не поддерживается.');
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
