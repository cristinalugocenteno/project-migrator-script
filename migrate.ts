// deno-lint-ignore-file no-explicit-any
import yargs from "https://cdn.deno.land/yargs/versions/yargs-v16.2.1-deno/raw/deno.ts";
import {
  buildPatch,
  buildRules,
  consoleLogger,
  getJson,
  ldAPIPatchRequest,
  ldAPIPostRequest,
  rateLimitRequest,
} from "./utils.ts";
import * as Colors from "https://deno.land/std/fmt/colors.ts";

// Uncommented these give an import error due to axios
// import {
//   EnvironmentPost,
//   Project,
//   ProjectPost,
//   FeatureFlagBody
// } from "https://github.com/launchdarkly/api-client-typescript/raw/main/api.ts";

interface Arguments {
  projKeySource: string;
  projKeyDest: string;
  apikey: string;
  domain: string;
}

let inputArgs: Arguments = yargs(Deno.args)
  .alias("p", "projKeySource")
  .alias("d", "projKeyDest")
  .alias("k", "apikey")
  .alias("u", "domain")
  .default("u", "app.launchdarkly.com").argv;

// Project Data //
const projectJson = await getJson(
  `./source/project/${inputArgs.projKeySource}/project.json`,
);

const buildEnv: Array<any> = [];

projectJson.environments.items.forEach((env: any) => {
  const newEnv: any = {
    name: env.name,
    key: env.key,
    color: env.color,
  };

  if (env.defaultTtl) newEnv.defaultTtl = env.defaultTtl;
  if (env.confirmChanges) newEnv.confirmChanges = env.confirmChanges;
  if (env.secureMode) newEnv.secureMode = env.secureMode;
  if (env.defaultTrackEvents) {
    newEnv.defaultTrackEvents = env.defaultTrackEvents;
  }
  if (env.tags) newEnv.tags = env.tags;

  buildEnv.push(newEnv);
});

const projRep = projectJson; //as Project
const projPost: any = {
  key: inputArgs.projKeyDest,
  name: projRep.name,
  tags: projRep.tags,
  environments: buildEnv,
}; //as ProjectPost

if (projRep.defaultClientSideAvailability) {
  projPost.defaultClientSideAvailability =
    projRep.defaultClientSideAvailability;
} else {
  projPost.includeInSnippetByDefault = projRep.includeInSnippetByDefault;
}

const projResp = await rateLimitRequest(
  ldAPIPostRequest(inputArgs.apikey, inputArgs.domain, `projects`, projPost),
);

consoleLogger(
  projResp.status,
  `Creating Project: ${projRep.key} Status: ${projResp.status}`,
);
const newProj = await projResp.json();

// Segment Data //

projRep.environments.items.forEach(async (env: any) => {
  const segmentData = await getJson(
    `./source/project/${inputArgs.projKeySource}/segment-${env.key}.json`,
  );
  // We are ignoring big segments/synced segments for now
  segmentData.items.forEach(async (segment: any) => {
    if (segment.unbounded == true) {
      console.log(Colors.yellow(
        `Segment: ${segment.key} in Environment ${env.key} is unbounded, skipping`,
      ));
      return;
    }

    const newSegment: any = {
      name: segment.name,
      key: segment.key,
    };

    if (segment.tags) newSegment.tags = segment.tags;
    if (segment.description) newSegment.description = segment.description;

    const segmentResp = await rateLimitRequest(
      ldAPIPostRequest(
        inputArgs.apikey,
        inputArgs.domain,
        `segments/${newProj.key}/${env.key}`,
        newSegment,
      ),
    );

    const segmentStatus = await segmentResp.status;
    consoleLogger(
      segmentStatus,
      `Creating segment ${newSegment.key} status: ${segmentStatus}`,
    );
    if (segmentStatus > 201) {
      console.log(JSON.stringify(newSegment));
    }

    // Build Segment Patches //
    const sgmtPatches = [];

    if (segment.included?.length > 0) {
      sgmtPatches.push(buildPatch("included", "add", segment.included));
    }
    if (segment.excluded?.length > 0) {
      sgmtPatches.push(buildPatch("excluded", "add", segment.excluded));
    }

    if (segment.rules?.length > 0) {
      console.log(`Copying Segment: ${segment.key} rules`);
      sgmtPatches.push(...buildRules(segment.rules));
    }

    const patchRules = await rateLimitRequest(
      ldAPIPatchRequest(
        inputArgs.apikey,
        inputArgs.domain,
        `segments/${newProj.key}/${env.key}/${newSegment.key}`,
        sgmtPatches,
      ),
    );

    const segPatchStatus = await patchRules.statusText;
    consoleLogger(
      segPatchStatus,
      `Patching segment ${newSegment.key} status: ${segPatchStatus}`,
    );
  });
});

// Flag Data //

const flagData = await getJson(
  `./source/project/${inputArgs.projKeySource}/flag.json`,
);

// Creating Global Flags //
for await (const flag of flagData.items) {
  const newVariations = flag.variations.map(({ _id, ...rest }) => rest);

  const newFlag: any = {
    key: flag.key,
    name: flag.name,
    variations: newVariations,
    temporary: flag.temporary,
    tags: flag.tags,
  };

  if (flag.client_side_availability) {
    newFlag.client_side_availability = flag.client_side_availability;
  } else if (flag.include_in_snippet) {
    newFlag.include_in_snippet = flag.include_in_snippet;
  }
  if (flag.custom_properties) {
    newFlag.custom_properties = flag.custom_properties;
  }

  if (flag.defaults) {
    newFlag.defaults = flag.defaults;
  }

  console.log(
    `Creating flag: ${flag.key} in Project: ${inputArgs.projKeyDest}`,
  );
  const flagResp = await rateLimitRequest(
    ldAPIPostRequest(
      inputArgs.apikey,
      inputArgs.domain,
      `flags/${inputArgs.projKeyDest}`,
      newFlag,
    ),
  );
  if (flagResp.status == 200 || flagResp.status == 201) {
    console.log("Flag created");
  } else {
    console.log(`Error for flag ${newFlag.key}: ${flagResp.status}`);
  }
}

// Send one patch per Flag for all Environments //
const envList: string[] = [];
projectJson.environments.items.forEach((env: any) => {
  envList.push(env.key);
});

for await (const flag of flagData.items) {
  const patchReq: any[] = [];
  for await (const env of envList) {
    const flagEnvData = flag.environments[env];
    const parsedData: Record<string, string> = Object.keys(flagEnvData)
      .filter((key) => !key.includes("salt"))
      .filter((key) => !key.includes("version"))
      .filter((key) => !key.includes("lastModified"))
      .filter((key) => !key.includes("_environmentName"))
      .filter((key) => !key.includes("_site"))
      .filter((key) => !key.includes("_summary"))
      .filter((key) => !key.includes("sel"))
      .reduce((cur, key) => {
        return Object.assign(cur, { [key]: flagEnvData[key] });
      }, {});

    Object.keys(parsedData)
      .map((key) => {
        if (key == "rules") {
          patchReq.push(...buildRules(parsedData[key], "environments/" + env));
        } else {
          patchReq.push(
            buildPatch(
              `environments/${env}/${key}`,
              "replace",
              parsedData[key],
            ),
          );
        }
      });
  }
  const patchFlagReq = await rateLimitRequest(
    ldAPIPatchRequest(
      inputArgs.apikey,
      inputArgs.domain,
      `flags/${inputArgs.projKeyDest}/${flag.key}`,
      patchReq,
    ),
  );
  const flagPatchStatus = await patchFlagReq.status;

  consoleLogger(
    flagPatchStatus,
    `Patching ${flag.key} with environment specific configuration, Status: ${flagPatchStatus}`,
  );
}