import * as Colors from "https://deno.land/std/fmt/colors.ts";

export async function getJson(filePath: string) {
	try {
		return JSON.parse(await Deno.readTextFile(filePath));
	} catch (e) {
		console.log(filePath + ": " + e.message);
	}
}

export async function rateLimitRequest(req: Request) {
	const rateLimitReq = req.clone();
	const res = await fetch(req);
	let newRes = res;
	if (res.status == 429) {
		const rateLimit = res.headers.get("x-ratelimit-reset");
		const end = Number(rateLimit) + 2_500;
		const d = new Date(0);
		d.setUTCMilliseconds(end);
		console.log(`Rate Limited until: ${d} `);
		while (Date.now() < end);
		console.log("Making new request");
		newRes = await fetch(rateLimitReq);
	}

	return newRes;
}

export function ldAPIPostRequest(
	apiKey: string,
	domain: string,
	path: string,
	body: any
) {
	const req = new Request(`https://${domain}/api/v2/${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: apiKey,
		},
		body: JSON.stringify(body),
	});

	return req;
}

export function ldAPIPatchRequest(
	apiKey: string,
	domain: string,
	path: string,
	body: any
) {
	const req = new Request(`https://${domain}/api/v2/${path}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Authorization: apiKey,
		},
		body: JSON.stringify(body),
	});

	return req;
}

export function buildPatch(key: string, op: string, value: any) {
	return {
		path: "/" + key,
		op,
		value,
	};
}

export function buildRules(
	rules: any,
	env?: string
): { path: string; op: string; value: any }[] {
	const newRules: { path: string; op: string; value: any }[] = [];
	const path = env ? `${env}/rules/-` : "rules/-";
	rules.map(({ clauses, _id, generation, deleted, version, ref, ...rest }) => {
		const newRule = rest;
		const newClauses = { clauses: clauses.map(({ _id, ...rest }) => rest) };
		Object.assign(newRule, newClauses);
		newRules.push(buildPatch(path, "add", newRule));
	});

	return newRules;
}

export async function writeSourceData(
	projPath: string,
	dataType: string,
	data: any
) {
	return await writeJson(`${projPath}/${dataType}.json`, data);
}

export function ldAPIRequest(apiKey: string, domain: string, path: string) {
	const req = new Request(`https://${domain}/api/v2/${path}`, {
		headers: {
			Authorization: apiKey,
		},
	});

	return req;
}

async function writeJson(filePath: string, o: any) {
	try {
		await Deno.writeTextFile(filePath, JSON.stringify(o));
	} catch (e) {
		console.log(e);
	}
}

export function consoleLogger(status: number, message: string) {
	if (status > 201 && status != 429) {
		return console.warn(Colors.yellow(message));
	}

	return console.log(message);
}
export function ldAPIGetMetricRequest(
	apiKey: string,
	domain: string,
	path: string
) {
	const req = new Request(`https://${domain}/api/v2/${path}`, {
		method: "GET",
		headers: {
			"Content-Type": "application/json",
			Authorization: apiKey,
		},
	});

	return req;
}
