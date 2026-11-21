import { AsyncLocalStorage } from "node:async_hooks";
import { after, mock } from "node:test";
import type { GrepQuery } from "../core/search.ts";
import type { HashlineEditConfig } from "./config.ts";
import type { OutputBudgetProvider } from "./budgets.ts";

import * as real from "./rg-process.ts";
export type MockRg = Partial<Pick<typeof real, "runRgPaths" | "runRgLines" | "rgRejectsPatterns">>;
const overrides = new AsyncLocalStorage<MockRg>();
const moduleMock = mock.module("./rg-process.ts", {
  namedExports: {
    ...real,
    runRgPaths: (...args: Parameters<typeof real.runRgPaths>) =>
      (overrides.getStore()?.runRgPaths ?? real.runRgPaths)(...args),
    runRgLines: (...args: Parameters<typeof real.runRgLines>) =>
      (overrides.getStore()?.runRgLines ?? real.runRgLines)(...args),
    rgRejectsPatterns: (...args: Parameters<typeof real.rgRejectsPatterns>) =>
      (overrides.getStore()?.rgRejectsPatterns ?? real.rgRejectsPatterns)(...args),
  },
});

after(() => moduleMock.restore());

// 在替身注册后才加载完整工具图，避免候选层捕获真实 rg 导出。
const factories = await import("./tool-factories.testing.ts");
const { searchFiles } = await import("./grep-search.ts");
const { listCandidates } = await import("./grep-candidates.ts");

export function makeMockGrep(
  cwd: string,
  config: HashlineEditConfig,
  rg: MockRg,
  budgets?: OutputBudgetProvider,
) {
  const tool = factories.makeGrepOverride(cwd, config, budgets);
  return {
    ...tool,
    execute: (...args: Parameters<typeof tool.execute>) =>
      overrides.run(rg, () => tool.execute(...args)),
  };
}

export function searchWithMockRg({
  backend,
  ...options
}: Parameters<typeof searchFiles>[0] & { readonly backend: MockRg }) {
  return overrides.run(backend, () => searchFiles(options));
}

// 观察生产候选流程生成的文件预筛参数，不复制私有序列化规则。
export async function fileCandidateArgs(query: GrepQuery): Promise<string[]> {
  let captured: string[] | undefined;
  await overrides.run(
    {
      runRgLines: async () => ({ code: 2, stderr: "", stopped: false }),
      rgRejectsPatterns: async (_patternArgs, _cwd, _signal) => true,
      runRgPaths: async (args) => {
        captured = args.slice(0, args.indexOf("--null"));
        return { code: 1, stderr: "", stopped: false };
      },
    },
    () =>
      listCandidates({
        query,
        scope: { cwd: process.cwd(), globs: [], searchPaths: [process.cwd()] },
        signal: new AbortController().signal,
        stopped: () => false,
        onCandidate: async () => true,
      }),
  );
  if (!captured) throw new Error("File prefilter was not observed");
  return captured;
}
