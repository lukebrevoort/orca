import { expect, test } from "bun:test";
import { readerNavigationVisibility, readerTargetIsVisible } from "./reader-navigation";
const viewport = { top: 68, bottom: 900 };
test("quiet jumps reflect the actual viewport without duplicating initial unread navigation", () => {
  const below = {top:1000,bottom:1200}, above = {top:-400,bottom:0}, visible = {top:300,bottom:1500};
  expect(readerNavigationVisibility(below,below,viewport,false)).toEqual({unread:false,latest:true});
  expect(readerNavigationVisibility(above,below,viewport,true)).toEqual({unread:true,latest:true});
  expect(readerNavigationVisibility(visible,visible,viewport,true)).toEqual({unread:false,latest:false});
  expect(readerNavigationVisibility(null,visible,viewport,true)).toEqual({unread:false,latest:false});
  expect(readerNavigationVisibility(above,below,{top:0,bottom:0},true)).toEqual({unread:false,latest:false});
});
test("partial cards remain visible while clipped and collapsed cards remain targets", () => {
  expect(readerTargetIsVisible({top:-500,bottom:1200},viewport)).toBe(true);
  expect(readerTargetIsVisible({top:850,bottom:920},viewport)).toBe(true);
  expect(readerTargetIsVisible({top:900,bottom:944},viewport)).toBe(false);
  expect(readerTargetIsVisible({top:0,bottom:0},viewport)).toBe(false);
});
