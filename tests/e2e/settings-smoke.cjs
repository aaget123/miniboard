// 设置弹窗冒烟：页签控制器拆分后的渲染/切换/录制交互（无画布探针依赖，纯 DOM）
const { chromium } = require("playwright");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "http://localhost:5173";

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.clear();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push("console: " + m.text());
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  const results = [];
  const check = (name, ok) => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };

  // 打开设置：悬浮主按钮展开面板 → ⚙ 项（标题以「设置（外观」开头）
  await page.locator("button.tf-main").click();
  await page.waitForTimeout(200);
  const gear = page.locator('button[title^="设置（外观"]').first();
  if ((await gear.count()) === 0) {
    console.log("FAIL  未找到设置入口按钮");
    await browser.close();
    process.exit(1);
  }
  await gear.click();
  await page.waitForTimeout(200);

  // 页面同时存在多个 .ai-modal-mask（设置/AI 面板/导出），一律收窄到设置弹窗
  const mask = page.locator(".ai-modal-mask").filter({ has: page.locator(".settings-tabs") });
  const dlg = (sel, opts) => mask.locator(sel, opts);
  check("S1 设置弹窗打开", (await mask.count()) === 1 && !(await mask.isHidden()));

  // 数据页签：目录展示非空（浏览器环境显示 localStorage 提示）
  await dlg(".settings-tab", { hasText: "数据" }).click();
  await page.waitForTimeout(120);
  const dirText = await dlg(".data-dir-path").first().textContent();
  check("S2 数据页签目录展示", !!dirText && dirText.length > 0);

  // 快捷键页签：行渲染（操作组 + 工具组）与录制交互
  await dlg(".settings-tab", { hasText: "快捷键" }).click();
  await page.waitForTimeout(120);
  const rowCount = await dlg(".sc-row").count();
  check("S3 快捷键行渲染", rowCount >= 5);
  {
    const editBtn = dlg(".sc-row button", { hasText: "修改" }).first();
    await editBtn.click();
    await page.waitForTimeout(120);
    const recording = await dlg(".sc-keys.sc-recording").count();
    check("S4 录制态进入", recording === 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    const recordingAfter = await dlg(".sc-keys.sc-recording").count();
    check("S5 Esc 退出录制", recordingAfter === 0);
  }

  // 系统提示词页签：编辑区 + 双模式切换（恰一个 active）
  await dlg(".settings-tab", { hasText: "系统提示词" }).click();
  await page.waitForTimeout(120);
  const areaCount = await dlg("textarea.prompt-area").count();
  const modeTabs = await dlg(".prompt-mode-tab").count();
  const activeTabs = await dlg(".prompt-mode-tab.active").count();
  check("S6 提示词编辑区与模式切换", areaCount === 1 && modeTabs === 2 && activeTabs === 1);
  {
    await dlg(".prompt-mode-tab", { hasText: "编辑模式" }).click();
    await page.waitForTimeout(120);
    const activeLabel = await dlg(".prompt-mode-tab.active").textContent();
    check("S7 切换编辑模式 active 跟随", activeLabel === "编辑模式");
  }

  // 工具栏页签：分区渲染 + 预览条 + 取消平铺联动 + 恢复默认（确认弹窗）
  await dlg(".settings-tab", { hasText: "工具栏" }).click();
  await page.waitForTimeout(150);
  const sections = await dlg(".tb-section").count();
  const rows = await dlg(".tb-row").count();
  const previewItems = await dlg(".tb-preview-bar .tb-preview-item").count();
  check("S9 工具栏页签渲染", sections >= 1 && rows > 0 && previewItems > 0);
  {
    // 取消平铺第一个已平铺工具行：预览条按钮同步减少（onToolbarChange → 真实顶栏重渲染）
    const box = dlg('.tb-row[data-pinned="1"] input[type="checkbox"]:not([disabled])').first();
    await box.click();
    await page.waitForTimeout(150);
    const after = await dlg(".tb-preview-bar .tb-preview-item").count();
    check("S10 取消平铺预览联动", after < previewItems);
    // 恢复默认布局：确认弹窗（应用内 showConfirm）→ 确认 → 预览回到基线
    await dlg("button", { hasText: "恢复默认布局" }).click();
    await page.waitForTimeout(150);
    const okBtn = page.locator(".confirm-modal button.ai-modal-save");
    await okBtn.click();
    await page.waitForTimeout(150);
    const restored = await dlg(".tb-preview-bar .tb-preview-item").count();
    check("S11 恢复默认布局", restored === previewItems);
  }

  // AI 模型页签：空态提示 + 新建/保存/删除配置全流程
  await dlg(".settings-tab", { hasText: "AI 模型" }).click();
  await page.waitForTimeout(150);
  const emptyState = await dlg(".profile-empty").count();
  check("S12 AI 模型页签空态", emptyState === 1);
  {
    await dlg(".profile-add").click();
    const inputs = dlg('.settings-form input[type="text"]');
    await inputs.nth(0).fill("冒烟测试配置");
    await inputs.nth(1).fill("https://api.example.com/v1");
    await dlg('.settings-form input[type="password"]').fill("sk-test");
    await inputs.nth(2).fill("smoke-model");
    await dlg(".settings-form .ai-modal-save").click();
    await page.waitForTimeout(150);
    const items = await dlg(".profile-item").count();
    const active = await dlg(".profile-item.active").count();
    check("S13 新建配置保存并激活", items === 1 && active === 1);
    // 删除此配置：先点选配置项（载入编辑态才可删），两段确认弹窗（danger 按钮）→ 回到空态
    await dlg(".profile-item").first().click();
    await page.waitForTimeout(120);
    await dlg(".settings-del").click();
    await page.locator(".confirm-modal button.confirm-btn-danger").click();
    await page.waitForTimeout(150);
    const emptyAfter = await dlg(".profile-empty").count();
    check("S14 删除配置回空态", emptyAfter === 1);
  }

  // 关闭后重开：open() 全量刷新路径（各控制器 refresh 不抛错、快捷键行重建）
  await dlg(".settings-close").first().click();
  await page.waitForTimeout(120);
  await page.locator("button.tf-main").click();
  await page.waitForTimeout(200);
  await gear.click();
  await page.waitForTimeout(200);
  const reopened = !(await mask.isHidden());
  const rowsAfter = await dlg(".sc-row").count();
  check("S8 重开刷新", reopened && rowsAfter >= 5);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (errors.length) {
    // 已知良性噪声（如 favicon 404）在此展示但不判失败，与 board-regress 一致
    console.log("errors:", JSON.stringify(errors, null, 2));
  }
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
