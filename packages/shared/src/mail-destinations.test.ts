import { expect, test } from "bun:test";
import { destinationCreateSchema, destinationRoutingChangeSchema, destinationUpdateSchema } from "./mail-destinations.ts";
test("destination contracts normalize names and strictly guard writes", () => {
 expect(destinationCreateSchema.parse({expectedRevision:1,name:"  Clients  "}).name).toBe("Clients");
 expect(destinationCreateSchema.safeParse({expectedRevision:0,name:"Clients"}).success).toBe(false);
 expect(destinationCreateSchema.safeParse({expectedRevision:1,name:"  "}).success).toBe(false);
 expect(destinationUpdateSchema.safeParse({expectedRevision:1}).success).toBe(false);
 expect(destinationRoutingChangeSchema.parse({expectedRevision:2,target:{scope:"sender",address:"MAYA@example.com"},destinationId:null}).target).toEqual({scope:"sender",address:"maya@example.com"});
 expect(destinationRoutingChangeSchema.safeParse({expectedRevision:1,target:{scope:"account"},destinationId:""}).success).toBe(false);
});
