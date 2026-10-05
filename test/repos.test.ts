import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseWorktreeDetails } from "../src/git.js";
import { isUsableWorktree, knownRepos, rememberRepo } from "../src/repos.js";

test("worktree details: branch per worktree, the first is the main checkout", () => {
  const out = [
    "worktree C:/p/app", "HEAD 1", "branch refs/heads/master", "",
    "worktree C:/o/.orca-preparing/39272-x", "HEAD 1", "detached", "",
    "worktree C:/o/app/demo1", "HEAD 2", "branch refs/heads/feat/login", "",
  ].join("\r\n");
  const d = parseWorktreeDetails(out);
  assert.deepEqual(d.map((w) => [w.branch, w.main]), [["master", true], [null, false], ["feat/login", false]]);
  assert.equal(isUsableWorktree(d[1].path), false, "Orca's temp folder is skipped");
});

test("projects are remembered once and forgotten when their folder is gone", () => {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wts-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wts-repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    rememberRepo(path.join(repo, ".git"), path.join(repo, "x"));
    rememberRepo(path.join(repo, ".git"), path.join(repo, "y")); // same repo again
    assert.equal(knownRepos().length, 1);
    assert.equal(knownRepos()[0].worktree, repo, "main checkout = the folder holding .git");
    fs.rmSync(repo, { recursive: true, force: true });
    assert.equal(knownRepos().length, 0);
  } finally {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
