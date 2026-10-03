import assert from "node:assert/strict";
import { parseRichText, richTextColor, stripRichText } from "../src/richtext.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("plain text is one run", () => {
  assert.deepEqual(parseRichText("Iron 50%"), [{ kind: "text", text: "Iron 50%", color: undefined, bold: false, scale: 1 }]);
});

test("colours nest and close, transparent hex keeps its alpha", () => {
  const runs = parseRichText("[color=#e94040]▏[/color][color=#00000000]███[/color] 1%");
  assert.deepEqual(runs.map((r) => (r.kind === "text" ? [r.text, r.color] : r.kind)), [["▏", "#e94040"], ["███", "#00000000"], [" 1%", undefined]]);
});

test("colour names, upper-case hex and r,g,b", () => {
  assert.equal(richTextColor("red"), "#ff2b2b");
  assert.equal(richTextColor("#FF0202"), "#ff0202");
  assert.equal(richTextColor("1,0.5,0"), "rgb(255,128,0)");
  assert.equal(richTextColor("255,0,0,128"), "rgba(255,0,0,0.502)");
  assert.equal(richTextColor("nope"), undefined);
});

test("fonts make text bold or bigger until closed", () => {
  const runs = parseRichText("[font=default-bold]A[/font]B[font=heading-1]C[/font]");
  assert.deepEqual(runs.map((r) => (r.kind === "text" ? [r.text, r.bold, r.scale] : r.kind)), [["A", true, 1], ["B", false, 1], ["C", true, 1.3]]);
});

test("icon tags, img and quality", () => {
  const runs = parseRichText("[item=iron-plate,quality=rare] x [virtual-signal=signal-A][img=fluid/water]");
  assert.deepEqual(runs.filter((r) => r.kind === "icon"), [
    { kind: "icon", type: "item", name: "iron-plate", quality: "rare" },
    { kind: "icon", type: "virtual-signal", name: "signal-A", quality: undefined },
    { kind: "icon", type: "fluid", name: "water", quality: undefined },
  ]);
});

test("unknown tags and stray brackets stay literal", () => {
  assert.equal(stripRichText("[foo=bar] a [b] [color=nonsense]x"), "[foo=bar] a [b] [color=nonsense]x");
});

test("a display-panel bar from a real blueprint", () => {
  const text = "[font=technology-slot-level-font][color=#ff0000][virtual-signal=signal-battery-low]░░[/color][/font]0%";
  const runs = parseRichText(text);
  assert.equal(runs[0]!.kind, "icon");
  assert.deepEqual(runs[1], { kind: "text", text: "░░", color: "#ff0000", bold: true, scale: 0.9 });
  assert.deepEqual(runs[2], { kind: "text", text: "0%", color: undefined, bold: false, scale: 1 });
  assert.equal(stripRichText(text), "signal battery low░░0%");
});

console.log(`\n${passed} passing`);
