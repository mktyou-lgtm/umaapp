// 収支計算（ローカル版。計算ロジックは public/sim.js をブラウザ版と共有）
import { db } from './db.js';
import { BET_TYPES, KIND_LABELS, analyze, classOf, cleanFilters, filterCandidates, normalizeName, roundStake } from '../public/sim.js';

const KINDS = {
  jockey: { id: 'jockey_id', name: 'jockey_name' },
  trainer: { id: 'trainer_id', name: 'trainer_name' },
  horse: { id: 'horse_id', name: 'horse_name' },
};
export { BET_TYPES };

/** 名前・読み仮名の部分一致で候補を返す（ひらがな入力も可） */
export function candidates(kind, q, from, to) {
  const k = KINDS[kind];
  if (!k) throw new Error('kind が不正です');
  if (!normalizeName(q)) return [];
  const rows = db.prepare(`
    SELECT e.${k.id} AS id, e.${k.name} AS name, COUNT(*) AS rides, p.kana AS kana
    FROM entries e
    JOIN races r ON r.race_id = e.race_id
    LEFT JOIN people p ON p.kind = ? AND p.id = e.${k.id}
    WHERE e.${k.id} IS NOT NULL AND r.date BETWEEN ? AND ?
    GROUP BY e.${k.id}`).all(kind, from, to);
  return filterCandidates(rows, q);
}

export function simulate({ kind, id, from, to, bet = '単勝', stake = 100, ...filters }) {
  const k = KINDS[kind];
  if (!k) throw new Error('kind が不正です');
  if (!BET_TYPES.includes(bet)) throw new Error('券種が不正です');
  stake = roundStake(stake);
  const f = cleanFilters(filters);

  const rows = db.prepare(`
    SELECT r.race_id, r.date, r.venue, r.race_no, r.name AS race_name, r.surface, r.distance, r.headcount,
           r.track_condition, r.class_text, r.grade,
           e.horse_no, e.frame_no, e.horse_name, e.jockey_name, e.trainer_name, e.finish, e.finish_num, e.odds, e.popularity,
           p.amount AS payout100
    FROM entries e
    JOIN races r ON r.race_id = e.race_id
    LEFT JOIN payouts p ON p.race_id = e.race_id AND p.bet_type = ? AND p.combination = CAST(e.horse_no AS TEXT)
    WHERE e.${k.id} = ? AND r.date BETWEEN ? AND ?
    ORDER BY r.date, r.race_id`).all(bet, id, from, to)
    .map(({ class_text, ...r }) => ({ ...r, cls: classOf(class_text, r.grade) }));

  // 名前は絞り込み前の出走から取る（該当レースが 0 件でも表示できるように）
  const name = rows[0]?.[k.name]
    ?? db.prepare(`SELECT ${k.name} AS n FROM entries WHERE ${k.id} = ? LIMIT 1`).get(id)?.n ?? null;
  return { kind, kindLabel: KIND_LABELS[kind], id, name, from, to, bet, filters: f, stakePerBet: stake, ...analyze(rows, f, stake) };
}
