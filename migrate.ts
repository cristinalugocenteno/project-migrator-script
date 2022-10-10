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
	delay,
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
	`./source/project/${inputArgs.projKeySource}/project.json`
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
	ldAPIPostRequest(inputArgs.apikey, inputArgs.domain, `projects`, projPost)
);

consoleLogger(
	projResp.status,
	`Creating Project: ${projRep.key} Status: ${projResp.status}`
);
const newProj = await projResp.json();

const end = 2_500;
const d = new Date(0);
d.setUTCMilliseconds(end);
console.log(`Rate Limited until: ${d} `);
while (Date.now() < end);

// Segment Data //

projRep.environments.items.forEach(async (env: any) => {
	const segmentData = await getJson(
		`./source/project/${inputArgs.projKeySource}/segment-${env.key}.json`
	);
	const end = 2_500;
	const d = new Date(0);
	d.setUTCMilliseconds(end);
	console.log(`Rate Limited until: ${d} `);
	while (Date.now() < end);
	// We are ignoring big segments/synced segments for now
	segmentData.items.forEach(async (segment: any) => {
		if (segment.unbounded == true) {
			console.log(
				Colors.yellow(
					`Segment: ${segment.key} in Environment ${env.key} is unbounded, skipping`
				)
			);
			return;
		}

		const newSegment: any = {
			name: segment.name,
			key: segment.key,
		};

		if (segment.tags) newSegment.tags = segment.tags;
		if (segment.description) newSegment.description = segment.description;

		// create each segment
		const post = ldAPIPostRequest(
			inputArgs.apikey,
			inputArgs.domain,
			`segments/${projRep.key}/${env.key}`,
			newSegment
		);

		const segmentResp = await rateLimitRequest(post);

		const segmentStatus = await segmentResp.status;
		consoleLogger(
			segmentStatus,
			`Creating segment ${newSegment.key} status: ${segmentStatus}`
		);
		if (segmentStatus > 201) {
			console.log(JSON.stringify(newSegment));
		}

		// patch for each segment to great the rules for the environmen

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
				sgmtPatches
			)
		);

		const segPatchStatus = await patchRules.statusText;
		consoleLogger(
			segPatchStatus,
			`Patching segment ${newSegment.key} status: ${segPatchStatus}`
		);
	});
});

// Flag Data //

const flagData = await getJson(
	`./source/project/${inputArgs.projKeySource}/flag.json`
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
		description: flag.description,
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
		`Creating flag: ${flag.key} in Project: ${inputArgs.projKeyDest}`
	);
	const flagResp = await rateLimitRequest(
		ldAPIPostRequest(
			inputArgs.apikey,
			inputArgs.domain,
			`flags/${inputArgs.projKeyDest}`,
			newFlag
		)
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

const flagsDoubleCheck: string[] = [];
var count = 0;

for await (const flag of flagData.items) {
	for await (const env of envList) {
		const patchReq: any[] = [];
		const flagEnvData = flag.environments[env];
		const parsedData: Record<string, string> = Object.keys(flagEnvData)
			.filter((key) => !key.includes("salt"))
			.filter((key) => !key.includes("version"))
			.filter((key) => !key.includes("lastModified"))
			.filter((key) => !key.includes("_environmentName"))
			.filter((key) => !key.includes("_site"))
			.filter((key) => !key.includes("_summary"))
			.filter((key) => !key.includes("sel"))
			.filter((key) => !key.includes("access"))
			.filter((key) => !key.includes("_debugEventsUntilDate"))
			.filter((key) => !key.startsWith("_"))
			.filter((key) => !key.startsWith("-"))
			.reduce((cur, key) => {
				return Object.assign(cur, { [key]: flagEnvData[key] });
			}, {});

		Object.keys(parsedData).map((key) => {
			if (key == "rules") {
				patchReq.push(...buildRules(parsedData[key], "environments/" + env));
			} else {
				patchReq.push(
					buildPatch(`environments/${env}/${key}`, "replace", parsedData[key])
				);
			}
		});
		await makePatchCall(flag.key, patchReq);
	}
}

async function makePatchCall(flagKey, patchReq) {
	const patchFlagReq = await rateLimitRequest(
		ldAPIPatchRequest(
			inputArgs.apikey,
			inputArgs.domain,
			`flags/${inputArgs.projKeyDest}/${flagKey}`,
			patchReq
		)
	);
	const flagPatchStatus = await patchFlagReq.status;
	if (flagPatchStatus > 200) {
		flagsDoubleCheck.push(flagKey);
		consoleLogger(
			flagPatchStatus,
			`Patching ${flagKey} with environment specific configuration, Status: ${flagPatchStatus}`
		);
	}

	if (flagPatchStatus == 400) {
		console.log(patchFlagReq);
	}

	consoleLogger(
		flagPatchStatus,
		`Patching ${flagKey} with environment specific configuration, Status: ${flagPatchStatus}`
	);

	return flagsDoubleCheck;
}

if (flagsDoubleCheck.length > 0) {
	console.log(
		"There are a few flags to double check as they have had an error or warning on the patch"
	);
	flagsDoubleCheck.forEach((flag) => {
		console.log(` - ${flag}`);
	});
}

// Metrics Data
const getMetrics = await getJson(
	`./source/project/${inputArgs.projKeySource}/metrics.json`
);
console.log(getMetrics);
getMetrics.items.forEach(async (metrics: any) => {
	const metric = await getJson(
		`./source/project/${inputArgs.projKeySource}/metrics-${metrics.key}.json`
	);

	let newMetric: any = {
		key: metric.key,
		kind: metric.kind,
	};
	console.log(newMetric, "new metric");
	//console.log(getMetrics.key, "key")
	//getMetrics.map(async (metric: any) => {

	// create a switch case

	switch (true) {
		case metric.kind === "custom" && metric.isNumeric === true:
			newMetric = {
				...newMetric,
				eventKey: metric.eventKey,
				isNumeric: metric.isNumeric,
				unit: metric.unit,
				successCriteria: metric.successCriteria,
			};
			break;
		case metric.kind === "custom" && metric.isNumeric === false:
			newMetric = {
				...newMetric,
				eventKey: metric.eventKey,
				isNumeric: metric.isNumeric,
			};

		case metric.kind === "pageview":
			newMetric = {
				...newMetric,
				urls: metric.urls,
			};
			break;

		case metric.kind === "click":
			newMetric = {
				...newMetric,
				selector: metric.selector,

				urls: metric.urls,
			};

		default:
			newMetric = {
				key: metric.key,
				kind: metric.kind,
			};
	}
	//    if (metric.kind === 'custom' && metric.isNumeric === true) {
	//        console.log(metric, 'if')
	//        newMetric = {
	//         ...newMetric,
	//         eventKey: metric.eventKey ,
	//         isNumeric: metric.isNumeric,
	//         unit: metric.unit,
	//         successCriteria: metric.successCriteria
	//    }
	//   }
	//    if (metric.kind === 'custom' && metric.isNumeric === false) {

	//     newMetric = {
	//       ...newMetric,
	//       eventKey: metric.eventKey ,
	//       isNumeric: metric.isNumeric,

	//  }
	// }
	//   if (metric.kind === 'pageview') {
	//        newMetric = {
	//         ...newMetric,
	//     urls: metric.urls
	//        }

	// }

	//  if (metric.kind === 'click') {

	//   newMetric = {
	//     ...newMetric,
	//     selector: metric.selector,

	// urls: metric.urls
	//    }
	// }

	console.log(newMetric, "new metric");
	console.log(
		`Creating metric: ${newMetric.key} in Project: ${inputArgs.projKeyDest}`
	);
	const metricResp = await rateLimitRequest(
		ldAPIPostRequest(
			inputArgs.apikey,
			inputArgs.domain,
			`metrics/${inputArgs.projKeyDest}`,
			newMetric
		)
	);

	console.log(metricResp, "metric response");
	if (metricResp.status == 200 || metricResp.status == 201) {
		console.log("Metric created");
	} else {
		console.log(`Error for metric ${newMetric.key}: ${metricResp.status}`);
	}
});
