import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCounts, filterEntries } from '../extension/ui-state.js';
const entries = [
  {title:'Готовый документ',status:'captured',captureId:'saved',characters:0},
  {title:'Сейчас читается',status:'waiting',captureId:'old-text'},
  {title:'Ожидает повтор',status:'pending',captureId:'partial-text'},
  {title:'Текст при таймауте',status:'timeout',captureId:'timeout-text'},
  {title:'Ошибка',status:'error'}, {title:'Закрыта',status:'closed'}, {title:'Другой адрес',status:'navigated'}
];
test('overview counts procedure outcomes, not mere presence of saved text',()=>{
 assert.deepEqual(pageCounts(entries),{total:7,saved:1,reading:1,pending:1,problems:4,processed:5,retryable:2});
 assert.deepEqual(pageCounts(),{total:0,saved:0,reading:0,pending:0,problems:0,processed:0,retryable:0});
});
test('fully processed backup with errors is not represented as fully saved',()=>{
 const counts=pageCounts(entries.slice(3));
 assert.equal(counts.processed,counts.total); assert.equal(counts.saved,0); assert.equal(counts.problems,4);
});
test('result filters and query compose without modifying the full backup or captures',()=>{
 const snapshot=structuredClone(entries);
 assert.deepEqual(filterEntries(entries,'saved').map(e=>e.captureId),['saved']);
 assert.deepEqual(filterEntries(entries,'problems','ТАЙМАУТ').map(e=>e.captureId),['timeout-text']);
 assert.equal(filterEntries(entries,'problems').length,4);
 assert.deepEqual(entries,snapshot); assert.equal(entries.length,7);
});
test('title search treats punctuation literally, normalizes Unicode and handles untitled documents',()=>{
 const documents=[{title:'== Разбор [A].*',status:'captured'},{title:'Cafe\u0301',status:'captured'},{title:'',status:'timeout'}];
 assert.equal(filterEntries(documents,'all','  [a].*  ')[0],documents[0]);
 assert.equal(filterEntries(documents,'all','CAFÉ')[0],documents[1]);
 assert.equal(filterEntries(documents,'all','без названия')[0],documents[2]);
 assert.equal(filterEntries(documents,'all','<script>').length,0);
});
