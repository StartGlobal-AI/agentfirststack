/** The runtime plus the optional features in ext.ts (dist/runtime-ext.txt; see index.ts). */
import { boot } from "./boot";
import { EXT } from "./core";
import { ext } from "./ext";

EXT.x = ext;
boot();
