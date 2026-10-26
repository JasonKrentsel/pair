import { ProcessTerminal, TuiAltScreen, Text } from "@earendil-works/pi-tui";
import { createReviewComponent } from "../extensions/pair/review.ts";
import { fixtures, fixtureTheme } from "./fixtures.ts";

const name = process.argv[2] ?? "multi";
const fixture = fixtures[name];
if (!fixture) throw new Error(`Choose a fixture: ${Object.keys(fixtures).join(", ")}`);
const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, {mouse:true});
const theme = fixtureTheme();
tui.addChild(new Text("Pair UI preview · synthetic data · no model or project changes",1,1));
const component = createReviewComponent({...fixture,tui,theme,done: (decision)=>{tui.stop(); console.log(JSON.stringify(decision));},onOpenExternal:async()=>{throw new Error("External opening is disabled in this synthetic preview.");}});
tui.showOverlay(component,{width:"96%",maxHeight:"96%",anchor:"center"});
tui.start();
for(const key of fixture.keys ?? []) component.handleInput(key);
