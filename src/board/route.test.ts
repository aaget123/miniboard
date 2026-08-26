import { describe, expect, it } from "vitest";
import { buildOrthoWaypoints } from "./geometry";

describe("buildOrthoWaypoints（正交折线 L 形路径）", () => {
  it("已共轴（水平 / 垂直）退化为直线：无中间点", () => {
    expect(buildOrthoWaypoints({ x: 0, y: 0 }, { x: 100, y: 0 })).toEqual([]);
    expect(buildOrthoWaypoints({ x: 0, y: 0 }, { x: 0, y: 80 })).toEqual([]);
    // 差值 < 0.5 视为共轴
    expect(buildOrthoWaypoints({ x: 0, y: 0 }, { x: 100, y: 0.4 })).toEqual([]);
  });

  it("水平主导：先横后纵，拐点取 (e.x, s.y)", () => {
    expect(buildOrthoWaypoints({ x: 0, y: 0 }, { x: 120, y: 40 })).toEqual([{ x: 120, y: 0 }]);
  });

  it("垂直主导：先纵后横，拐点取 (s.x, e.y)", () => {
    expect(buildOrthoWaypoints({ x: 0, y: 0 }, { x: 30, y: 90 })).toEqual([{ x: 0, y: 90 }]);
  });

  it("prefer 显式覆盖主导判定（连接器按绑定边出入方向传入）", () => {
    expect(buildOrthoWaypoints({ x: 0, y: 0 }, { x: 120, y: 40 }, "v")).toEqual([
      { x: 0, y: 40 },
    ]);
    expect(buildOrthoWaypoints({ x: 0, y: 0 }, { x: 30, y: 90 }, "h")).toEqual([
      { x: 30, y: 0 },
    ]);
  });
});
