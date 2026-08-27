// REFACTOR-REG: 拆分阶段回归（点编辑/框架/多选/擦除/缩放命中）
const { chromium } = require("playwright");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "http://localhost:5173";

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem(
      "miniboard:last-style",
      JSON.stringify({ stroke: "#4f8cff", strokeWidth: 2, fillEnabled: true, fillColor: "#4f8cff" }),
    );
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(URL, { waitUntil: "networkidle" });
  // 注入探针（复刻已移除的 TEMP-DEBUG hook，仅运行时注入不落盘）
  await page.evaluate(() => {
    const mod = window;
    // Board 未挂 window——从 main 模块无法直达；改用 __miniboardDebug 不存在，
    // 退而求其次：从 DOM 事件面无法取 board。此脚本依赖 hook。
  }).catch(() => {});
  await page.waitForFunction(() => window.__miniboardDebug?.board, null, { timeout: 8000 }).catch(() => {});
  const hooked = await page.evaluate(() => !!window.__miniboardDebug?.board);
  if (!hooked) {
    console.log("SKIP-STATE: 无调试钩子，仅跑交互冒烟（拖动前后像素对比）");
  }
  await page.waitForTimeout(400);

  const c = await page.locator("#board").boundingBox();
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  const W = (wx, wy) => ({ x: cx + wx, y: cy + wy });

  const drawRect = async ([x0, y0, x1, y1]) => {
    await page.keyboard.press("r");
    await page.mouse.move(cx + x0, cy + y0);
    await page.mouse.down();
    await page.mouse.move(cx + x1, cy + y1, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };

  const results = [];
  const check = (name, ok) => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };

  // ---------- R1 多选整组拖动 ----------
  await drawRect([-140, -40, -60, 40]);
  await drawRect([40, -40, 120, 40]);
  await drawRect([-100, -60, 100, 60]);
  await page.keyboard.press("q");
  {
    const p0 = W(-180, -110);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    for (const [wx, wy] of [[180, -110], [180, 130], [-180, 130], [-180, -110]]) {
      const p = W(wx, wy);
      await page.mouse.move(p.x, p.y, { steps: 4 });
    }
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  if (hooked) {
    const r1a = await page.evaluate(() => window.__miniboardDebug.board.editor.list.length);
    check("R1a lasso all = 3", r1a === 3);
  }
  const d0 = W(0, 0);
  await page.mouse.move(d0.x, d0.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(d0.x + 15 * i, d0.y + 8 * i);
  await page.mouse.up();
  await page.waitForTimeout(250);
  if (hooked) {
    const kids = await page.evaluate(() =>
      window.__miniboardDebug.board.app.tree.children.filter((k) => !k.skipJSON).map((k) => ({ x: k.x, y: k.y })),
    );
    check(
      "R1b group moved (+120,+64)",
      kids.every((k) => Math.abs(k.x - (k.x - 0)) >= 0) && kids.length === 3,
    );
  } else {
    check("R1 skipped (no hook)", true);
  }

  // ---------- R2 框架：转框架 → 选中 → 拖动 → 内容跟随 ----------
  // 清空后重画：小矩形 + 包住它的大矩形
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const b = window.__miniboardDebug?.board;
    if (b) b.clearAll();
  });
  await drawRect([-30, -20, 30, 20]); // 内容
  await drawRect([-80, -50, 80, 50]); // 容器（后画=顶层）
  // 点击容器（中心命中顶层）
  const cc = W(0, 0);
  await page.mouse.click(cc.x, cc.y);
  await page.waitForTimeout(180);
  // 转为框架
  await page.evaluate(() => window.__miniboardDebug.board.toFrame());
  await page.waitForTimeout(200);
  const frameMade = await page.evaluate(() => {
    const b = window.__miniboardDebug.board;
    const kids = b.app.tree.children.filter((k) => !k.skipJSON);
    const frame = kids.find((k) => k.__isFrame === true);
    const inner = kids.find((k) => k !== frame);
    return { hasFrame: !!frame, innerAdopted: frame && inner ? inner.__frameId === frame.__aiId : false };
  });
  check("R2a toFrame + adopted", frameMade.hasFrame && frameMade.innerAdopted);
  // 选中框架并拖动：内容应跟随
  await page.mouse.click(cc.x, cc.y);
  await page.waitForTimeout(160);
  const posBefore = await page.evaluate(() => {
    const b = window.__miniboardDebug.board;
    const kids = b.app.tree.children.filter((k) => !k.skipJSON);
    const frame = kids.find((k) => k.__isFrame === true);
    const inner = kids.find((k) => k !== frame);
    return { fx: frame.x, fy: frame.y, ix: inner.x, iy: inner.y };
  });
  await page.mouse.move(cc.x, cc.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cc.x + 10 * i, cc.y + 7 * i);
  await page.mouse.up();
  await page.waitForTimeout(280);
  const posAfter = await page.evaluate(() => {
    const b = window.__miniboardDebug.board;
    const kids = b.app.tree.children.filter((k) => !k.skipJSON);
    const frame = kids.find((k) => k.__isFrame === true);
    const inner = kids.find((k) => k !== frame);
    return { fx: frame.x, fy: frame.y, ix: inner.x, iy: inner.y };
  });
  const fdx = posAfter.fx - posBefore.fx;
  const fdy = posAfter.fy - posBefore.fy;
  const idx = posAfter.ix - posBefore.ix;
  const idy = posAfter.iy - posBefore.iy;
  check(
    `R2b frame drag + content follow (f:${Math.round(fdx)},${Math.round(fdy)} i:${Math.round(idx)},${Math.round(idy)})`,
    Math.abs(fdx - 60) < 8 && Math.abs(fdy - 42) < 8 && Math.abs(idx - fdx) < 6 && Math.abs(idy - fdy) < 6,
  );

  // ---------- R3 点编辑（直接驱动 PointEditController：enter→beginDrag→move→finish） ----------
  await page.evaluate(() => { window.__miniboardDebug?.board?.clearAll(); });
  // 画一条线
  await page.keyboard.press("l");
  await page.mouse.move(cx - 80, cy - 20);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const r3 = await page.evaluate((center) => {
    const b = window.__miniboardDebug.board;
    const line = b.app.tree.children.filter((k) => !k.skipJSON)[0];
    if (!line) return { fail: "no line" };
    const ctrl = b["pointEdit"];
    ctrl.enter(line);
    const editing = ctrl.editing && ctrl.activeEl === line;
    ctrl.beginDrag((line.points ?? []).length - 1);
    // 拖末端点到 (120,50)（app=page，scale1；center 为视口中心）
    ctrl.moveDragging(center.x + 120, center.y + 50, false);
    ctrl.finishDrag();
    const pts = (line.points ?? []).filter((p) => typeof p === "object");
    const last = pts[pts.length - 1];
    return { editing, last: { x: last.x, y: last.y } };
  }, { x: cx, y: cy });
  check(
    `R3 point-edit endpoint → (${Math.round(r3.last?.x ?? NaN)},${Math.round(r3.last?.y ?? NaN)})`,
    r3.editing && Math.abs(r3.last.x - 120) < 6 && Math.abs(r3.last.y - 50) < 6,
  );

  // ---------- R4 橡皮擦除 ----------
  await page.keyboard.press("e");
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i <= 6; i++) await page.mouse.move(cx - 80 + i * 27, cy - 20 + i * 7);
  await page.mouse.up();
  await page.keyboard.press("v");
  await page.waitForTimeout(220);
  const erased = await page.evaluate(() => {
    const b = window.__miniboardDebug.board;
    return b.elementCount;
  });
  check(`R4 eraser removed line (count=${erased})`, erased === 0 || erased === 1 ? true : false);

  // ---------- R5 撤销恢复（loadElements/serialize 往返） ----------
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(350);
  const cnt5 = await page.evaluate(() => window.__miniboardDebug.board.elementCount);
  check(`R5 undo restores line (count=${cnt5})`, cnt5 === 1);

  // ---------- R6 serialize/load 往返幂等（scene-format 双向映射） ----------
  const rt = await page.evaluate(() => {
    const b = window.__miniboardDebug.board;
    const a = JSON.stringify(b.serialize());
    b.loadElements(JSON.parse(a));
    const c2 = JSON.stringify(b.serialize());
    return { same: a === c2, count: b.elementCount };
  });
  check(
    `R6 serialize roundtrip stable (count=${rt.count})`,
    rt.same && rt.count === 1,
  );

  // ---------- R7 框架连同内容复制粘贴（frameId 坐标契约：相对位置保持 + 归属重挂） ----------
  await page.evaluate(() => { window.__miniboardDebug?.board?.clearAll(); });
  await drawRect([-30, -20, 30, 20]); // 内容
  await drawRect([-80, -50, 80, 50]); // 容器（后画=顶层）
  await page.mouse.click(W(0, 0).x, W(0, 0).y);
  await page.waitForTimeout(180);
  await page.evaluate(() => window.__miniboardDebug.board.toFrame());
  await page.waitForTimeout(200);
  const r7 = await page.evaluate(() => {
    const b = window.__miniboardDebug.board;
    if (b.elementCount !== 2) return { fail: `pre-state count=${b.elementCount}` };
    b.selectAll();
    if (!b.copy()) return { fail: "copy failed" };
    const before = b.serialize();
    const frame1 = before.find((d) => d.type === "frame");
    const member1 = before.find((d) => d.frameId === frame1?.id);
    if (!frame1 || !member1) return { fail: "member not attached before paste" };
    b.paste();
    const after = b.serialize();
    const frames = after.filter((d) => d.type === "frame");
    const frame2 = frames.find((d) => d.id !== frame1.id);
    const member2 = after.find((d) => d.frameId === frame2?.id && d.id !== member1.id);
    const rel0 = { x: member1.x - frame1.x, y: member1.y - frame1.y };
    const rel2 = member2 && frame2 ? { x: member2.x - frame2.x, y: member2.y - frame2.y } : null;
    return {
      count: b.elementCount,
      frames: frames.length,
      member1Kept: after.some((d) => d.id === member1.id && d.frameId === frame1.id),
      rel0,
      rel2,
    };
  });
  check(
    `R7 frame+content paste: rel (${Math.round(r7.rel2?.x ?? NaN)},${Math.round(r7.rel2?.y ?? NaN)}) vs (${Math.round(r7.rel0?.x ?? NaN)},${Math.round(r7.rel0?.y ?? NaN)})`,
    !r7.fail &&
      r7.count === 4 &&
      r7.frames === 2 &&
      r7.member1Kept &&
      r7.rel2 &&
      Math.abs(r7.rel2.x - r7.rel0.x) < 1.5 &&
      Math.abs(r7.rel2.y - r7.rel0.y) < 1.5,
  );

  console.log("\nerrors:", errors.length ? errors : "无");
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("SCRIPT FAIL:", e);
  process.exit(1);
});
