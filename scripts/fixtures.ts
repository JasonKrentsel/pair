import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { filePreview } from "../extensions/pair/changes.ts";
import type { ChangePreview } from "../extensions/pair/review-model.ts";

export function fixtureTheme(name = "dark"): Theme {
  initTheme(name, false);
  const json = JSON.parse(readFileSync(join(getPackageDir(), `dist/modes/interactive/theme/${name}.json`), "utf8"));
  const resolve = (c: string | number): string | number => typeof c === "string" && json.vars[c] !== undefined ? resolve(json.vars[c]) : c;
  const colors = Object.fromEntries(Object.entries(json.colors).map(([k,v])=>[k,resolve(v as string)]));
  return new Theme(colors as never, colors as never, "truecolor", {name,appearance:name === "light" ? "light" : "dark"});
}

const source = `import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Return a completed agent report, preserving useful failure details. */
export function getFinalAnswer(session: AgentSession): string {
  const message = session.state.messages.at(-1);
  if (message?.role !== "assistant" || message.stopReason !== "stop") {
    throw new Error("The agent did not finish its report");
  }
  const answer = session.getLastAssistantText()?.trim();
  if (!answer) throw new Error("The agent returned an empty answer");
  return answer;
}
`;
const longBefore = Array.from({length:40},(_,i)=> i === 2 ? 'export const thinking = "off";' : i === 31 ? 'export const retryLimit = 3;' : `// Configuration detail ${i+1}`).join("\n")+"\n";
const code = filePreview("src/agent.ts",longBefore,longBefore.replace('"off"','"medium"').replace('retryLimit = 3','retryLimit = 5'),"Edit");
const readme = filePreview("README.md", "# Run\n\nUse the default endpoint configured in the environment. The application starts one orchestrator session and prints its response.\n\n```powershell\nnpm start -- \"Inspect this project\"\n```\n", "# Run\n\nSelect the provider and role configurations explicitly. Each role can use a different model, thinking level, and Markdown prompt while the application retains control of its permissions.\n\n```powershell\nnpm start -- --models ./models.local.json --agents ./agents.local.json \"Inspect this project\"\n```\n", "Edit");
export interface Fixture { title: string; why: string; changes: ChangePreview[]; keys?: string[]; readOnly?: boolean }
export const fixtures: Record<string,Fixture> = {
  command:{title:"Check the configuration changes",why:"Type-check and run the focused session tests before updating the usage documentation. Requests stay on the local scripted server.",changes:[{label:"npm run check",kind:"bash",command:"npm run check",cwd:"C:\\Projects\\example",added:0,removed:0}]},
  "long-command":{title:"Check configuration and session behavior",why:"Verify the role loader and CLI wiring. This uses local scripted responses.",changes:[{label:"checks",kind:"powershell",command:"npm run check && node --import tsx --test tests/agent-config.test.ts tests/fresh-app.test.ts",cwd:"C:\\Projects\\example",added:0,removed:0}]},
  single:{title:"Make thinking and retry limits explicit",why:"These defaults apply to newly created sessions. The role configuration can override thinking; retry behavior remains shared.",changes:[code]},
  new:{title:"Extract the shared report validation",why:"Both callers need to reject incomplete reports. This keeps the existing validation in one small helper.",changes:[filePreview("src/answer.ts","",source,"New file")]},
  json:{title:"Add the provider example",why:"The example documents the supported provider format and contains no credentials.",changes:[filePreview("models.example.json","",JSON.stringify({providers:{local:{baseUrl:"http://127.0.0.1:1234/v1",api:"openai-completions",models:[{id:"local-model",reasoning:false}]}}},null,2)+"\n","New file")]},
  markdown:{title:"Document explicit configuration",why:"The instructions should match the CLI. This explains selecting provider and role files and keeps the example runnable.",changes:[readme]},
  multi:{title:"Share report validation between callers",why:"Both callers reject unfinished or empty reports using the same helper. This keeps their behavior consistent.",changes:[filePreview("src/answer.ts","",source,"New file"),filePreview("src/index.ts",'const answer = session.getLastAssistantText();\nconsole.log(answer);\n','import { getFinalAnswer } from "./answer.ts";\nconst answer = getFinalAnswer(session);\nconsole.log(answer);\n',"Edit")]},
  four:{title:"Update the configuration defaults and examples",why:"Keep the documented defaults aligned with the implementation. Each file is part of this one configuration change.",changes:[code,readme,filePreview("config/很长的文件名.json","{}\n",'{"thinking":"medium","label":"你好 🙂"}\n',"Edit"),filePreview("empty.txt","","Ready\n","New file")]},
  note:{title:"Share report validation between callers",why:"Both callers reject unfinished or empty reports using the same helper.",changes:[filePreview("src/answer.ts","",source,"New file"),code],keys:["n","Keep the CLI output open-ended for now."]},
  failure:{title:"Stopped · 1/3 files completed",why:"The second action failed. The first file remains applied; the last file was not run.",readOnly:true,changes:[{...code,status:"Applied"},{...readme,status:"Failed — inspect result",text:"The file changed after review. Read it before preparing a new proposal."},{...filePreview("config.json","{}\n",'{"enabled":true}\n',"Edit"),status:"Not run — proposed"}]},
};
