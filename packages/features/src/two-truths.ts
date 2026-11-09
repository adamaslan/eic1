/**
 * Two truths and a lie: one round per circle. Full rounds, including the lie index, must stay on the author's device;
 * guessers see only the three statements until the author reveals. Pure logic: no I/O,
 * no network, no vault record kinds. Only publicView output may be shared with guessers. This module does not encrypt records.
 */

export const MAX_STATEMENT_CHARS = 160;
export const MAX_GUESSERS = 10;
export const MAX_GUESS_BYTES = 256;

export interface TwoTruthsRound {
  id: string;
  authorId: string;
  statements: [string, string, string];
  /** Held by the author. Stripped from every view until reveal. */
  lieIndex: 0 | 1 | 2;
  status: "collecting" | "revealed";
  guesses: Record<string, 0 | 1 | 2>;
  createdAt: string;
  revealedAt?: string;
}

export type PublicTwoTruthsRound = Omit<TwoTruthsRound, "lieIndex"> & { lieIndex?: 0 | 1 | 2 };

export interface CreateRoundInput {
  id: string;
  authorId: string;
  statements: [string, string, string] | string[];
  lieIndex: 0 | 1 | 2;
  now: Date;
}

const encoder = new TextEncoder();

function isChoice(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

/** UTF-8 size of the guess submission envelope, not the stored guesses map entry. */
export function guessBytes(guesserId: string, index: 0 | 1 | 2): number {
  return encoder.encode(JSON.stringify({ guesserId, index })).length;
}

export function createRound(input: CreateRoundInput): TwoTruthsRound {
  if (input.statements.length !== 3) {
    throw new Error("A round needs exactly three statements.");
  }
  const statements = input.statements.map((text) => text.trim()) as [string, string, string];
  for (const text of statements) {
    if (!text) throw new Error("Every statement needs some text.");
    if (text.length > MAX_STATEMENT_CHARS) {
      throw new Error(`Each statement must be ${MAX_STATEMENT_CHARS} characters or fewer.`);
    }
  }
  if (!isChoice(input.lieIndex)) {
    throw new Error("The lie must be statement 0, 1 or 2.");
  }
  return {
    id: input.id,
    authorId: input.authorId,
    statements,
    lieIndex: input.lieIndex,
    status: "collecting",
    guesses: {},
    createdAt: input.now.toISOString(),
  };
}

/** What a guesser or friend may see. The lie index is removed until reveal. */
export function publicView(round: TwoTruthsRound): PublicTwoTruthsRound {
  if (round.status === "revealed") return { ...round };
  const { lieIndex: _hidden, ...rest } = round;
  return rest;
}

export function submitGuess(round: TwoTruthsRound, guesserId: string, index: 0 | 1 | 2, now: Date): TwoTruthsRound {
  if (round.status === "revealed") throw new Error("This round is already revealed.");
  if (guesserId === round.authorId) throw new Error("The author cannot guess their own round.");
  if (!isChoice(index)) throw new Error("A guess must be statement 0, 1 or 2.");
  if (guessBytes(guesserId, index) > MAX_GUESS_BYTES) {
    throw new Error(`A guess must fit in ${MAX_GUESS_BYTES} bytes.`);
  }
  const isNew = !Object.hasOwn(round.guesses, guesserId);
  if (isNew && Object.keys(round.guesses).length >= MAX_GUESSERS) {
    throw new Error("This round is full; no more guessers can join.");
  }
  // Retained for API compatibility; guesses do not currently store timestamps.
  void now;
  return { ...round, guesses: { ...round.guesses, [guesserId]: index } };
}

export function reveal(round: TwoTruthsRound, actorId: string, now: Date): TwoTruthsRound {
  if (actorId !== round.authorId) throw new Error("Only the author can reveal the round.");
  if (round.status === "revealed") throw new Error("This round was already revealed.");
  return { ...round, status: "revealed", revealedAt: now.toISOString() };
}

export function tally(round: TwoTruthsRound): { guessers: number; correct: number; wrong: number } {
  if (round.status !== "revealed") throw new Error("Results are only available after reveal.");
  const values = Object.values(round.guesses);
  const correct = values.filter((choice) => choice === round.lieIndex).length;
  return { guessers: values.length, correct, wrong: values.length - correct };
}
