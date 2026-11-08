import { describe, expect, it } from "vitest";
import {
  MAX_GUESSERS,
  MAX_GUESS_BYTES,
  MAX_STATEMENT_CHARS,
  createRound,
  guessBytes,
  publicView,
  reveal,
  submitGuess,
  tally,
  type TwoTruthsRound,
} from "./two-truths";

const NOW = new Date("2026-11-08T12:00:00Z");
const STATEMENTS: [string, string, string] = [
  "I once rode a horse to school",
  "I can juggle three oranges",
  "I have never seen snow",
];

function openRound(lieIndex: 0 | 1 | 2 = 2): TwoTruthsRound {
  return createRound({ id: "r1", authorId: "author", statements: STATEMENTS, lieIndex, now: NOW });
}

describe("createRound", () => {
  it("creates a collecting round with the lie index held by the author", () => {
    const round = openRound(1);
    expect(round.status).toBe("collecting");
    expect(round.lieIndex).toBe(1);
    expect(round.guesses).toEqual({});
  });

  it("trims statements and rejects blanks", () => {
    const round = createRound({ id: "r", authorId: "a", statements: [" x ", "y", "z"], lieIndex: 0, now: NOW });
    expect(round.statements[0]).toBe("x");
    expect(() =>
      createRound({ id: "r", authorId: "a", statements: ["  ", "y", "z"], lieIndex: 0, now: NOW }),
    ).toThrow(/statement/i);
  });

  it("rejects statements longer than the 160-character limit", () => {
    const long = "a".repeat(MAX_STATEMENT_CHARS + 1);
    expect(() =>
      createRound({ id: "r", authorId: "a", statements: [long, "y", "z"], lieIndex: 0, now: NOW }),
    ).toThrow(/160/);
  });

  it("rejects a lie index outside 0-2 or a non-integer", () => {
    expect(() => createRound({ id: "r", authorId: "a", statements: STATEMENTS, lieIndex: 3 as never, now: NOW })).toThrow();
    expect(() => createRound({ id: "r", authorId: "a", statements: STATEMENTS, lieIndex: 1.5 as never, now: NOW })).toThrow();
  });
});

describe("publicView", () => {
  it("hides the lie index while the round is collecting", () => {
    const view = publicView(openRound(2));
    expect(view).not.toHaveProperty("lieIndex");
    expect(view.statements).toEqual(STATEMENTS);
  });

  it("shows the lie index after reveal", () => {
    const revealed = reveal(openRound(2), "author", NOW);
    expect(publicView(revealed).lieIndex).toBe(2);
  });
});

describe("submitGuess", () => {
  it("records a guess and keeps the record within the 256-byte limit", () => {
    const round = submitGuess(openRound(2), "bob", 2, NOW);
    expect(round.guesses.bob).toBe(2);
    expect(guessBytes("bob", 2)).toBeLessThanOrEqual(MAX_GUESS_BYTES);
  });

  it("lets a guesser change their guess before reveal", () => {
    const first = submitGuess(openRound(2), "bob", 0, NOW);
    const second = submitGuess(first, "bob", 2, NOW);
    expect(second.guesses.bob).toBe(2);
    expect(Object.keys(second.guesses)).toHaveLength(1);
  });

  it("refuses an out-of-range guess", () => {
    expect(() => submitGuess(openRound(), "bob", 5 as never, NOW)).toThrow();
  });

  it("refuses the author guessing their own round", () => {
    expect(() => submitGuess(openRound(), "author", 0, NOW)).toThrow(/author/i);
  });

  it("caps the number of distinct guessers at MAX_GUESSERS", () => {
    let round = openRound();
    for (let i = 0; i < MAX_GUESSERS; i++) round = submitGuess(round, `g${i}`, 0, NOW);
    expect(() => submitGuess(round, "one-too-many", 0, NOW)).toThrow(/full/i);
    // An existing guesser can still change their mind at the cap.
    expect(submitGuess(round, "g0", 1, NOW).guesses.g0).toBe(1);
  });

  it("refuses guesses after reveal", () => {
    const revealed = reveal(openRound(), "author", NOW);
    expect(() => submitGuess(revealed, "bob", 0, NOW)).toThrow(/revealed/i);
  });
});

describe("reveal", () => {
  it("only the author can reveal", () => {
    expect(() => reveal(openRound(), "bob", NOW)).toThrow(/author/i);
  });

  it("is single-use", () => {
    const revealed = reveal(openRound(), "author", NOW);
    expect(() => reveal(revealed, "author", NOW)).toThrow(/already/i);
  });
});

describe("tally", () => {
  it("counts correct and wrong guesses after reveal", () => {
    let round = openRound(2);
    round = submitGuess(round, "bob", 2, NOW);
    round = submitGuess(round, "cy", 0, NOW);
    round = submitGuess(round, "di", 2, NOW);
    const result = tally(reveal(round, "author", NOW));
    expect(result).toEqual({ guessers: 3, correct: 2, wrong: 1 });
  });

  it("refuses to tally before reveal so the answer cannot leak early", () => {
    expect(() => tally(submitGuess(openRound(), "bob", 2, NOW))).toThrow(/reveal/i);
  });
});
