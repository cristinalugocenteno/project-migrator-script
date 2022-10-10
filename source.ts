import yargs from "https://cdn.deno.land/yargs/versions/yargs-v16.2.1-deno/raw/deno.ts";
import {
	ensureDir,
	ensureDirSync,
} from "https://deno.land/std@0.149.0/fs/mod.ts";
import {
	consoleLogger,
	ldAPIRequest,
	writeSourceData,
	ldAPIGetMetricRequest,
} from "./utils.ts";

interface Arguments {
	projKey: string;
	apikey: string;
	domain: string;
}

let inputArgs: Arguments = yargs(Deno.args)
	.alias("p", "projKey")
	.alias("k", "apikey")
	.alias("u", "domain")
	.default("u", "app.launchdarkly.com").argv;

// Project Data //
const projResp = await fetch(
	ldAPIRequest(
		inputArgs.apikey,
		inputArgs.domain,
		`projects/${inputArgs.projKey}?expand=environments`
	)
);
if (projResp == null) {
	console.log("Failed getting project");
	Deno.exit(1);
}
const projData = await projResp.json();
const projPath = `./source/project/${inputArgs.projKey}`;
ensureDirSync(projPath);

await writeSourceData(projPath, "project", projData);

// Segment Data //

if (projData.environments.items.length > 0) {
	projData.environments.items.forEach(async (env: any) => {
		console.log(env.key);
		const segmentResp = await fetch(
			ldAPIRequest(
				inputArgs.apikey,
				inputArgs.domain,
				`segments/${inputArgs.projKey}/${env.key}`
			)
		);
		if (segmentResp == null) {
			console.log("Failed getting Segments");
			Deno.exit(1);
		}
		const segmentData = await segmentResp.json();

		await writeSourceData(projPath, `segment-${env.key}`, segmentData);
		const end = Date.now() + 2_000;
		while (Date.now() < end);
	});
}

// Flag Data //
const flagResp = await fetch(
	ldAPIRequest(
		inputArgs.apikey,
		inputArgs.domain,
		`flags/${inputArgs.projKey}?summary=false`
	)
);
if (flagResp.status > 201) {
	consoleLogger(flagResp.status, `Error getting flags: ${flagResp.status}`);
	consoleLogger(flagResp.status, await flagResp.text());
}
if (flagResp == null) {
	console.log("Failed getting Flags");
	Deno.exit(1);
}

const flagData = await flagResp.json();

await writeSourceData(projPath, "flag", flagData);

//get metrics list

const metricResp = await fetch(
	ldAPIGetMetricRequest(
		inputArgs.apikey,
		inputArgs.domain,
		`/metrics/${inputArgs.projKey}`
	)
);

if (metricResp.status > 201) {
	consoleLogger(metricResp.status, `Error getting flags: ${metricResp.status}`);
	consoleLogger(metricResp.status, await metricResp.text());
}
if (metricResp == null) {
	console.log("Failed getting Metrics");
	Deno.exit(1);
}
const metricData = await metricResp.json();

await writeSourceData(projPath, `metrics`, metricData);

//get the individual metrics info

let metricKey: any;

metricKey = metricData.items.forEach(async (metric: any) => {
	//console.log(metric.key);
	const metrics = await fetch(
		ldAPIGetMetricRequest(
			inputArgs.apikey,
			inputArgs.domain,
			`metrics/${inputArgs.projKey}/${metric.key}`
		)
	);
	metricKey = await metrics.json();
	console.log(metricKey);

	if (metrics.status > 201) {
		consoleLogger(metrics.status, `Error getting flags: ${metrics.status}`);
		consoleLogger(metrics.status, await metrics.text());
	}
	if (metrics == null) {
		console.log("Failed getting Metrics");
		Deno.exit(1);
	}
	await writeSourceData(projPath, `metrics-${metric.key}`, metricKey);
});
