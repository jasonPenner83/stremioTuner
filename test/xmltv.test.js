import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toXmltvDate, escapeXml, buildXmltv } from '../src/xmltv.js';

test('toXmltvDate formats an ISO string as XMLTV UTC date', () => {
  assert.equal(toXmltvDate('2026-07-22T10:05:09.000Z'), '20260722100509 +0000');
});

test('escapeXml escapes reserved characters', () => {
  assert.equal(escapeXml(`Tom & Jerry: "Cat" <3>`), 'Tom &amp; Jerry: &quot;Cat&quot; &lt;3&gt;');
});

test('buildXmltv includes a channel tag and programme tags for each item', () => {
  const xml = buildXmltv([
    {
      id: 'marvel-movies',
      name: 'Marvel Movies',
      schedule: {
        items: [
          { id: 'tt1', title: 'Iron Man', start: '2026-07-22T00:00:00.000Z', end: '2026-07-22T02:06:00.000Z' }
        ]
      }
    }
  ]);
  assert.match(xml, /<channel id="marvel-movies">/);
  assert.match(xml, /<display-name>Marvel Movies<\/display-name>/);
  assert.match(xml, /<programme start="20260722000000 \+0000" stop="20260722020600 \+0000" channel="marvel-movies">/);
  assert.match(xml, /<title>Iron Man<\/title>/);
});

test('buildXmltv handles a channel with no schedule yet', () => {
  const xml = buildXmltv([{ id: 'x', name: 'X', schedule: null }]);
  assert.match(xml, /<channel id="x">/);
  assert.doesNotMatch(xml, /<programme/);
});
