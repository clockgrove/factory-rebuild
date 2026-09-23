import { pinnedGit } from "../process.js";

/** Replay one independently prepared result on the observed integration head. */
export function transplantIndependentChange(
  checkout: string,
  originalBase: string,
  changeRef: string,
  integratedBase: string,
): { changeRef: string; treeSha: string } {
  if (pinnedGit(checkout, "rev-parse", `${changeRef}^`) !== originalBase)
    throw new Error(
      "Prepared change has a different parent than its execution base",
    );
  const treeSha = pinnedGit(
    checkout,
    "merge-tree",
    "--write-tree",
    `--merge-base=${originalBase}`,
    integratedBase,
    changeRef,
  );
  if (!/^[0-9a-f]{40}$/.test(treeSha))
    throw new Error("Prepared change did not replay to one unconflicted tree");
  const rebased = pinnedGit(
    checkout,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@users.noreply.github.com",
    "commit-tree",
    treeSha,
    "-p",
    integratedBase,
    "-m",
    "Factory: replay independently prepared Work Item",
  );
  return { changeRef: rebased, treeSha };
}
