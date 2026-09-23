import assert from "node:assert/strict";
import test from "node:test";
import { linearDeliveryUnits } from "../dist/delivery/plan.js";

function item(id, dependencies = []) {
  return { id, dependencies };
}

test("maximal chains stop at forks and joins", () => {
  const graph = {
    items: [
      item("foundation"),
      item("left", ["foundation"]),
      item("left2", ["left"]),
      item("right", ["foundation"]),
      item("join", ["left2", "right"]),
      item("tail", ["join"]),
    ],
  };
  assert.deepEqual(
    linearDeliveryUnits(graph).map((unit) => ({
      items: unit.items.map((part) => part.id),
      external: unit.externalDependencies,
    })),
    [
      { items: ["foundation"], external: [] },
      { items: ["left", "left2"], external: ["foundation"] },
      { items: ["right"], external: ["foundation"] },
      { items: ["join", "tail"], external: ["left2", "right"] },
    ],
  );
});

test("chain of one stays one delivery unit", () => {
  assert.deepEqual(
    linearDeliveryUnits({ items: [item("only")] }).map((unit) =>
      unit.items.map((part) => part.id),
    ),
    [["only"]],
  );
});

test("unit order follows dependencies even when compiler output is unsorted", () => {
  const units = linearDeliveryUnits({
    items: [item("join", ["left", "right"]), item("right"), item("left")],
  });
  assert.deepEqual(
    units.map((unit) => unit.items.map((part) => part.id)),
    [["right"], ["left"], ["join"]],
  );
});
