import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, ARROW_CHOICES, MIN_PLAYERS } from '../server/room.js';

const shootEnd = (room, id, value = 9, x = false) => {
  for (let i = 0; i < 6; i++) {
    const m = room.match;
    const n = m.scores[id].flat().length;
    assert.ok(room.recordArrow(id, { matchId: m.id, n, end: m.currentEnd, value, x }).ok);
  }
};

test('射数は 6 の倍数で 72 本まで', () => {
  assert.deepEqual(ARROW_CHOICES, [6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72]);
  const r = new Room();
  r.join('a', 'A'); r.join('b', 'B');
  for (const bad of [0, 5, 7, 78, 'x']) assert.equal(r.start('a', { arrows: bad, distance: 70 }).ok, false, String(bad));
  assert.ok(r.start('a', { arrows: 12, distance: 70 }).ok);
  assert.equal(r.match.ends, 2);
});

test(`${MIN_PLAYERS}人以上が接続しているときだけ試合を開始できる`, () => {
  const r = new Room();
  r.join('a', 'A');
  assert.equal(r.canStart(), false);
  assert.equal(r.start('a', { arrows: 6, distance: 18 }).ok, false);
  r.join('b', 'B');
  assert.equal(r.canStart(), true);
  r.leave('b');
  assert.equal(r.canStart(), false);
  r.join('b', 'B');
  assert.ok(r.start('a', { arrows: 6, distance: 18 }).ok);
  assert.equal(r.canStart(), false, '進行中は開始できない');
  assert.deepEqual(r.match.participants, ['a', 'b']);
});

test('全員が射ち終えるまで次のエンドに進まず、他のエンドや 7 本目は受け付けない', () => {
  const r = new Room();
  r.join('a', 'A'); r.join('b', 'B');
  r.start('a', { arrows: 12, distance: 70, environment: { windSpeed: 3, seed: 42 } });
  assert.equal(r.match.environment.windSpeed, 3);
  assert.equal(r.match.environment.distance, 70);
  shootEnd(r, 'a');
  assert.equal(r.match.currentEnd, 1);
  assert.equal(r.recordArrow('a', { matchId: r.match.id, n: 6, end: 1, value: 10 }).ok, false, '7本目');
  assert.equal(r.recordArrow('a', { matchId: r.match.id, n: 6, end: 2, value: 10 }).ok, false, '先のエンド');
  shootEnd(r, 'b');
  assert.equal(r.match.currentEnd, 2);
  shootEnd(r, 'a', 10, true);
  shootEnd(r, 'b', 10);
  assert.equal(r.match.status, 'finished');
  const st = r.standings();
  assert.equal(st[0].id, 'a', '同点なら X の数で上位');
  assert.equal(st[0].total, 114);
  assert.equal(st[1].rank, 2);
});

test('同じ矢の再送 (通算本数 n が同じ) は二重に記録しない', () => {
  const r = new Room();
  r.join('a', 'A'); r.join('b', 'B');
  r.start('a', { arrows: 6, distance: 18 });
  const id = r.match.id;
  assert.ok(r.recordArrow('a', { matchId: id, n: 0, end: 1, value: 8 }).ok);
  const dup = r.recordArrow('a', { matchId: id, n: 0, end: 1, value: 8 });
  assert.equal(dup.ok, false);
  assert.equal(dup.silent, true);
  assert.equal(r.match.scores.a[0].length, 1);
});

test('切断した選手は待たずに進行し、残りの矢は M になる。戻れば続きから射てる', () => {
  const r = new Room();
  r.join('a', 'A'); r.join('b', 'B'); r.join('c', 'C');
  r.start('a', { arrows: 18, distance: 30 });
  shootEnd(r, 'a'); shootEnd(r, 'b');
  r.recordArrow('c', { matchId: r.match.id, n: 0, end: 1, value: 7 });
  r.leave('c');
  assert.equal(r.match.currentEnd, 2);
  assert.deepEqual(r.match.scores.c[0].map((a) => a.label), ['7', 'M', 'M', 'M', 'M', 'M']);
  r.join('c', 'C');
  assert.equal(r.snapshot('c').match.mine[0].length, 6);
  shootEnd(r, 'a'); shootEnd(r, 'b');
  assert.equal(r.match.currentEnd, 2, '戻った選手を待つ');
  shootEnd(r, 'c');
  assert.equal(r.match.currentEnd, 3);
});

test('出場者が全員切断したら試合を打ち切る', () => {
  const r = new Room();
  r.join('a', 'A'); r.join('b', 'B');
  r.start('a', { arrows: 6, distance: 18 });
  r.leave('a'); r.leave('b');
  assert.equal(r.match, null);
  assert.equal(r.players.size, 0);
});

test('試合後も、退出した選手の名前は結果に残る', () => {
  const r = new Room();
  r.join('a', 'A'); r.join('b', 'Bob');
  r.start('a', { arrows: 6, distance: 18 });
  r.snapshot('a');
  shootEnd(r, 'a');
  r.leave('b');
  assert.equal(r.match.status, 'finished');
  assert.equal(r.snapshot('a').match.standings.find((s) => s.id === 'b').name, 'Bob');
});
