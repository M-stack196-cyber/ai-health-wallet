// Prints problem codes (never values) for the environment this process was started with. Exit 1 when any exist.
import { stagingEnvironmentProblems } from "./staging-environment.js";
const problems = stagingEnvironmentProblems(process.env);
console.log(JSON.stringify({ ok: problems.length === 0, problems }));
process.exitCode = problems.length ? 1 : 0;
