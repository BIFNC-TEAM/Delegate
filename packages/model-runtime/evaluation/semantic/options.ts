/** pnpm may forward its argument separator; direct Node does not add one. */
export function parseOptions(argv: string[]) {
  const args = argv.filter(arg => arg !== "--");
  const mode = args.find(a => a.startsWith("--mode="))?.split("=")[1] ?? "calibrate";
  const repetitions = Number(args.find(a => a.startsWith("--repetitions="))?.split("=")[1] ?? 2);
  if (args.some(a => !["--live", "--same-model-judge"].includes(a) && !/^--(?:mode|repetitions)=/.test(a))) throw Error("unknown option");
  if (!args.includes("--live") || !["calibrate", "subjects"].includes(mode) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw Error("Use --help; --live is required.");
  return { mode, repetitions, sameModelJudge: args.includes("--same-model-judge") };
}
