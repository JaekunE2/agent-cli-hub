'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProjectRefsStore } = require('../project-refs');

test('project-refs stores text and binary/image files safely and builds task prompt block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-proj-refs-'));
  try {
    const store = createProjectRefsStore(dir);
    const savedTxt = store.saveFile('proj_1', { name: '../spec.md', text: '# API Spec\nGET /items' });
    assert.equal(savedTxt.name, 'spec.md');
    assert.equal(savedTxt.isImage, false);

    // 1x1 PNG base64
    const pngB64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const savedImg = store.saveFile('proj_1', { name: 'mockup.png', contentBase64: pngB64 });
    assert.equal(savedImg.name, 'mockup.png');
    assert.equal(savedImg.isImage, true);

    const list = store.list('proj_1');
    assert.equal(list.length, 2);

    const readImg = store.readFile('proj_1', 'mockup.png');
    assert.equal(readImg.mime, 'image/png');
    assert.ok(readImg.buf.length > 10);

    const block = store.promptBlock('proj_1');
    assert.ok(block.includes('[프로젝트 참조 데이터 저장소]'));
    assert.ok(block.includes(store.dirOf('proj_1')));
    assert.ok(block.includes('spec.md'));
    assert.ok(block.includes('mockup.png'));
    assert.ok(block.includes('다른 태스크나 후속 AI 작업으로 넘길'));

    const afterDel = store.deleteFile('proj_1', 'spec.md');
    assert.equal(afterDel.length, 1);
    assert.equal(afterDel[0].name, 'mockup.png');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
