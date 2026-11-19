// 収支計算（ローカル版。計算ロジックは public/sim.js をブラウザ版と共有）
import { db } from './db.js';
import { BET_TYPES, KIND_LABELS, normalizeName, roundStake, summarize } from '../public/sim.js';

const KINDS = {
  jockey: { id: 'jockey_id', name: 'jockey_name' },
  trainer: { id: 'trainer_id', name: 'trainer_name' },
  horse: { id: 'horse_id', name: 'horse_name' },
};
export { BET_TYPES };

/** 名前の部分一致で候補を返す */
export function candidates(kind, q, from, to) {
  const k = KINDS[kind];
  if (!k) throw new Error('kind が不正です');
  const name = normalizeName(q);
  if (!name) return [];
  return db.prepare(`
    SELECT e.${k.id} AS id, e.${k.name} AS name, COUNT(*) AS rides
    FROM entries e JOIN races r ON r.race_id = e.race_id
    WHERE e.${k.id} IS NOT NULL AND REPLACE(e.${k.name}, ' ', '') LIKE ? AND r.date BETWEEN ? AND ?
    GROUP BY e.${k.id} ORDER BY rides DESC LIMIT 20`).all(`%${name}%`, from, to);
}

export function simulate({ kind, id, from, to, bet = '単勝', stake = 100 }) {
  const k = KINDS[kind];
  if (!k) throw new Error('kind が不正です');
  if (!BET_TYPES.includes(bet)) throw new Error('券種が不正です');
  stake = roundStake(stake);

  const rows = db.prepare(`
    SELECT r.race_id, r.date, r.venue, r.race_no, r.name AS race_name, r.surface, r.distance, r.headcount,
           e.horse_no, e.horse_name, e.jockey_name, e.trainer_name, e.finish, e.finish_num, e.odds, e.popularity,
           p.amount AS payout100
    FROM entries e
    JOIN races r ON r.race_id = e.race_id
    LEFT JOIN payouts p ON p.race_id = e.race_id AND p.bet_type = ? AND p.combination = CAST(e.horse_no AS TEXT)
    WHERE e.${k.id} = ? AND r.date BETWEEN ? AND ?
    ORDER BY r.date, r.race_id`).all(bet, id, from, to);

  const name = rows[0]?.[k.name] ?? null;
  return { kind, kindLabel: KIND_LABELS[kind], id, name, from, to, bet, stakePerBet: stake, ...summarize(rows, stake) };
}
