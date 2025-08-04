const axios = require("axios");
const https = require("https");
const v4Agemt = new https.Agent({
    family: 4,
});

const INTERVAL_SECONDS = process.env.INTERVAL_SECONDS || 600;

const CLOUDFLARE_CDN_CGI_TRACE_URL = "https://cloudflare.com/cdn-cgi/trace";
const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
const IPIFY_V4_API_URL = "https://api.ipify.org?format=json";

let IN_PROGRESS = false;
let currentIPv4 = "";
const RECORDS_IP = {};
let counter = 1;

async function getPublicIp() {
    try {
        const response = await axios.get(CLOUDFLARE_CDN_CGI_TRACE_URL, {
            httpsAgent: v4Agemt,
            timeout: 3000,
        });
        const ip = response.data.match(/ip=(.*)/)[1];
        return ip;
    } catch (error) {
        console.error("Failed to get public IP from cloudflare.com", error);
        try {
            const response = await axios.get(IPIFY_V4_API_URL, { timeout: 3000 });
            const ip = response.data.ip;
            return ip;
        } catch (error) {
            console.error("Failed to get public IP", error);
            return null;
        }
    }
}

// Get record from cloudflare
async function getRecord(zoneIdentifier, recordName, v = "A") {
    const { auth } = require("./config.json");
    try {
        const response = await axios.get(
            `${CLOUDFLARE_API_URL}/zones/${zoneIdentifier}/dns_records?type=${v}&name=${recordName}`,
            {
                headers: {
                    "X-Auth-Email": auth.email,
                    Authorization: "Bearer " + auth.token,
                    "Content-Type": "application/json",
                },
                httpsAgent: v4Agemt,
            }
        );
        if (response.data.result_info.count === 0) {
            console.error(
                `Record does not exist, perhaps create one first? for ${recordName} of type ${v}`
            );
            return null;
        }
        return response.data.result[0];
    } catch (error) {
        console.error("Failed to get record", error);
        return null;
    }
}

// Update record in cloudflare
async function updateRecord(
    zoneIdentifier,
    recordIdentifier,
    ip,
    proxied = false
) {
    const { auth } = require("./config.json");
    try {
        await axios.patch(
            `${CLOUDFLARE_API_URL}/zones/${zoneIdentifier}/dns_records/${recordIdentifier}`,
            {
                content: ip,
                ttl: 300,
                proxied,
            },
            {
                headers: {
                    "X-Auth-Email": auth.email,
                    Authorization: "Bearer " + auth.token,
                    "Content-Type": "application/json",
                },
                httpsAgent: v4Agemt,
            }
        );
        return true;
    } catch (error) {
        console.error("Failed to update record", error);
        return false;
    }
}

async function startUpdate() {
    IN_PROGRESS = true;
    const { records } = require("./config.json");
    const results = [];
    for (let i = 0; i < records.length; i++) {
        const { name, proxied, type, zoneId } = records[i];
        if (type !== "A") {
            console.log(`Skipping record ${name} of unsupported type ${type}. Only A records are handled.`);
            results.push(false);
            continue;
        }
        const ip = await getPublicIp();
        if (!ip) {
            console.error("Failed to get public IP");
            results.push(false);
            continue;
        }

        const recordData = await getRecord(zoneId, name, type);
        if (!recordData) {
            console.error("Failed to get record for record", name);
            results.push(false);
            continue;
        }

        RECORDS_IP[`${name}-${type}`] = recordData.content;
        if (recordData.content == ip) {
            results.push(true);
            continue;
        }
        console.log("IP has changed for record", name);

        console.log("Updating record...");
        const result = await updateRecord(zoneId, recordData.id, ip, proxied);
        if (!result) {
            console.error(
                "Failed to update record for record",
                records[i],
                "of type",
                type
            );
            results.push(false);
            continue;
        }
        console.log(
            "Updated record",
            recordData.name,
            type,
            recordData.content,
            ip
        );
        results.push(true);
    }
    IN_PROGRESS = false;
    return results;
}

const interval = setInterval(async () => {
    /**
     * Every 4th cycle, we force update all records
     */
    if (counter % 4 == 0) {
        counter = 1;
        !IN_PROGRESS && startUpdate();
        return;
    }
    counter++;
    const ipv4 = await getPublicIp();

    let chaned = false;

    for (const key in RECORDS_IP) {
        if (RECORDS_IP[key] != ipv4) {
            chaned = true;
            break;
        }
    }

    if (ipv4 != currentIPv4 || chaned) {
        if (IN_PROGRESS) {
            return;
        }

        const updatedResults = await startUpdate();
        if (updatedResults.includes(false)) {
            console.error("Failed to update all records");
        } else {
            currentIPv4 = ipv4;
        }
    }
}, INTERVAL_SECONDS * 1000);

console.log("Service started");

process.on("SIGTERM", () => {
    clearInterval(interval);
    process.exit();
});

process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit();
});
