import { makeApplication, readDescriptor } from "./integration-fixture.mjs";

const [descriptorPath, objectiveText] = process.argv.slice(2);
if (!descriptorPath || !objectiveText)
  throw new Error("restart controller requires descriptor and Objective");

const { application } = makeApplication(readDescriptor(descriptorPath));
await application.runObjective(Number(objectiveText));
