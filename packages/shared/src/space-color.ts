import { z } from "zod";

export const defaultSpaceColor = "#70867d";
export const spaceColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a six-digit hex color");
