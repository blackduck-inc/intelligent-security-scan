// Copyright (c) 2024 Black Duck Software, Inc. All rights reserved worldwide.

const core = require('@actions/core');
const shell = require('shelljs');
const fs = require('fs');

try {
	const ioServerUrl = core.getInput('ioServerUrl');
	const ioServerToken = core.getInput('ioServerToken');
	const runId = core.getInput('runId');
	const workflowServerUrl = core.getInput('workflowServerUrl');
	const workflowVersion = core.getInput('workflowVersion');
	const ioManifestUrl = core.getInput('ioManifestUrl');
	const additionalWorkflowArgs = core.getInput('additionalWorkflowArgs')
	const stage = core.getInput('stage')
	var rcode = -1
	const releaseType = core.getInput('releaseType')
	const manifestType = core.getInput('manifestType')

	let scmType = "github"
	let scmOwner = process.env.GITHUB_REPOSITORY.split('/')[0]
	let scmRepoName = process.env.GITHUB_REPOSITORY.split('/')[1]
	let scmBranchName = ""
	let githubUsername = process.env.GITHUB_ACTOR
	let asset_id = process.env.GITHUB_REPOSITORY

	if (process.env.GITHUB_EVENT_NAME === "push" || process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
		scmBranchName = process.env.GITHUB_REF.split('/')[2]
	} else if (process.env.GITHUB_EVENT_NAME === "pull_request") {
		scmBranchName = process.env.GITHUB_HEAD_REF
	}

	if (ioServerToken === "" && ioServerUrl === "http://localhost:9090") {
		//optionally can run ephemeral IO containers here
		console.log("\nAuthenticating the Ephemeral IO Server");
		shell.exec(`curl ${ioServerUrl}/api/onboarding/onboard-requests -H "Content-Type:application/vnd.synopsys.io.onboard-request-2+json" -d '{"user":{"username": "ephemeraluser", "password": "P@ssw0rd!", "name":"ephemeraluser", "email":"user@ephemeral.com"}}'`, { silent: true });
		shell.exec(`curl -D cookie.txt ${ioServerUrl}/api/auth/login -H "Content-Type: application/json" -d '{"loginId": "ephemeraluser","password": "P@ssw0rd!"}'`, { silent: true });
		shell.exec(`sed -n 's/.*access_token*= *//p' cookie.txt > line.txt`);
		let access_token = shell.exec(`sed 's/;.*//' line.txt`).stdout.trim();
		shell.exec(`curl ${ioServerUrl}/api/auth/tokens -H "Authorization: Bearer ${access_token}" -H "Content-Type: application/json" -o output.json -d '{"name": "ephemeral-token"}'`, { silent: true })
		ioServerToken = shell.exec(`jq -r '.token' output.json`, { silent: true }).stdout.trim();
		removeFiles(["cookie.txt", "line.txt", "output.json"]);
		console.log("\nEphemeral IO Server Authentication Completed");
	}

	// Irrespective of Machine this should be invoked
	if (stage.toUpperCase() === "IO") {
		console.log("Triggering prescription")

		removeFiles(["prescription.sh"]);

		shell.exec(`wget https://raw.githubusercontent.com/blackduck-inc/io-artifacts/${workflowVersion}/prescription.sh`)
		shell.exec(`chmod +x prescription.sh`)
		shell.exec(`sed -i -e 's/\r$//' prescription.sh`)
		rcode = shell.exec(`./prescription.sh --io.url=${ioServerUrl} --io.token="${ioServerToken}" --io.manifest.url=${ioManifestUrl} --manifest.type=${manifestType} --stage=${stage} --release.type=${releaseType} --workflow.version=${workflowVersion} --asset.id=${asset_id} --scm.type=${scmType} --scm.owner=${scmOwner} --scm.repo.name=${scmRepoName} --scm.branch.name=${scmBranchName} --github.username=${githubUsername} ${additionalWorkflowArgs}`).code;
		if (rcode != 0) {
			core.error(`Error: Execution failed and returncode is ${rcode}`);
			core.setFailed();
		}

		let rawdata = fs.readFileSync('result.json');
		let result_json = JSON.parse(rawdata);
		let preDefinedActivities = { "sca": "scaScan", "dast": "dastScan", "threatmodel": "threatmodelScan", "network": "networkScan", "cloud": "cloudScan", "infra": "infraScan", "sast": "sastScan", "dastplusm": "dastplusmScan", "imagescan": "imageScan", "sastplusm": "sastplusmScan" };
		let activities = result_json.security.activities
		console.log(`\n================================== IO Prescription =======================================`)
		for (let val in activities) {
			if (preDefinedActivities[val.toLowerCase()]) {
				console.log(`Is ${activities[val].longName}(${val.toUpperCase()}) Enabled: ${activities[val].enabled}`);
				rcode = shell.exec(`echo ::set-output name=${preDefinedActivities[val.toLowerCase()]}::${activities[val].enabled}`).code;
				if (rcode != 0) {
					core.error(`Error: Execution failed and returncode is ${rcode}`);
					core.setFailed();
				}
			}
		}

		rcode = shell.exec(`echo ::set-output name=runId::${result_json.runId}`).code;
		if (rcode != 0) {
			core.error(`Error: Execution failed and returncode is ${rcode}`);
			core.setFailed();
		}

		if (getPersona(additionalWorkflowArgs) === "devsecops") {
			console.log("==================================== IO Risk Score =======================================")
			console.log(`Business Criticality Score - ${result_json.riskScoreCard.bizCriticalityScore}`)
			console.log(`Data Class Score - ${result_json.riskScoreCard.dataClassScore}`)
			console.log(`Access Score - ${result_json.riskScoreCard.accessScore}`)
			console.log(`Open Vulnerability Score - ${result_json.riskScoreCard.openVulnScore}`)
			console.log(`Change Significance Score - ${result_json.riskScoreCard.changeSignificanceScore}`)
			let bizScore = parseFloat(result_json.riskScoreCard.bizCriticalityScore.split("/")[1])
			let dataScore = parseFloat(result_json.riskScoreCard.dataClassScore.split("/")[1])
			let accessScore = parseFloat(result_json.riskScoreCard.accessScore.split("/")[1])
			let vulnScore = parseFloat(result_json.riskScoreCard.openVulnScore.split("/")[1])
			let changeScore = parseFloat(result_json.riskScoreCard.changeSignificanceScore.split("/")[1])
			console.log(`Total Score - ${bizScore + dataScore + accessScore + vulnScore + changeScore}`)
		}

		removeFiles(["io.yml", "io.yml", "data.json"]);
	} else if (stage.toUpperCase() === "WORKFLOW") {
		console.log("Adding scan tool parameters")
		// file doesn't exist
		if (!fs.existsSync("prescription.sh")) {
			shell.exec(`wget https://raw.githubusercontent.com/blackduck-inc/io-artifacts/${workflowVersion}/prescription.sh`)
			shell.exec(`chmod +x prescription.sh`)
			shell.exec(`sed -i -e 's/\r$//' prescription.sh`)
		}

		var wffilecode = shell.exec(`./prescription.sh --io.url=${ioServerUrl} --io.token="${ioServerToken}" --io.manifest.url=${ioManifestUrl} --manifest.type=${manifestType} --stage=${stage} --release.type=${releaseType} --workflow.version=${workflowVersion} --workflow.url=${workflowServerUrl} --asset.id=${asset_id} --scm.type=${scmType} --scm.owner=${scmOwner} --scm.repo.name=${scmRepoName} --scm.branch.name=${scmBranchName} --github.username=${githubUsername} ${additionalWorkflowArgs}`).code;

		let configFile = ""

		if (wffilecode == 0) {
			console.log("Workflow file generated successfullly....Calling WorkFlow Engine")
			if (manifestType === "yml") {
				configFile = "io.yml"
			} else if (manifestType === "json") {
				configFile = "io.json"
			}

			var wfclientcode = shell.exec(`java -jar WorkflowClient.jar --ioiq.url=${ioServerUrl} --ioiq.token="${ioServerToken}" --run.id="${runId}" --workflowengine.url="${workflowServerUrl}" --io.manifest.path="${configFile}"`).code;
			if (wfclientcode != 0) {
				core.error(`Error: Workflow failed and returncode is ${wfclientcode}`);
				core.setFailed();
			}

			try {
				let rawdata = fs.readFileSync('wf-output.json');
				let wf_output_json = JSON.parse(rawdata);
				console.log("========================== IO WorkflowEngine Summary ============================")
				console.log(`Breaker Status - ${wf_output_json.breaker.status}`)
			} catch {}
		} else {
			core.error(`Error: Workflow file generation failed and returncode is ${wffilecode}`);
			core.setFailed();
		}

		removeFiles([configFile]);
	} else {
		core.error(`Error: Invalid stage given as input`);
		core.setFailed();
	}
} catch (error) {
	core.setFailed(error.message);
}

function removeFiles(fileNames) {
	for (let file of fileNames) {
		if (fs.existsSync(file)) {
			try {
				fs.unlinkSync(file);
			} catch (err) {
			}
		}
	}
}

function getPersona(additionalWorkflowArgs) {
	let additionalWorkflowOptions = additionalWorkflowArgs.split(" ")
	for (let value of additionalWorkflowOptions) {
		let opt = value.split("=")
		if (opt[0] === "--persona") {
			return opt[1];
		}
	}
}