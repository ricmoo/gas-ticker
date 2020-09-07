"use strict";

/**
 *  @TODO
 *  - add --output to change database path
 *  - add --quiet
 */

const fs = require("fs");
const { resolve } = require("path");

const { ethers } = require("ethers");
const level = require("level-rocksdb");

const { getGasPrices } = require("./analyse");

// How often to run the purge tasks (seconds)
const PURGE_PERIOD = 60;

// How often to dump statistics to the gas-price.json
const DUMP_PERIOD = 20;

// Maximum age of Blocks and Transactions to monitor (seconds)
const MAX_AGE = 2 * 24 * 60 * 60;

// How long to wiat without new blocks/transactions before a forced exit (seconds)
const MAX_DISCONNECT = 10;

// Get the provider to use
let provider = null;
if (process.argv.length > 2) {
    provider = new ethers.providers.WebSocketProvider(process.argv[2]);
} else {
    provider = ethers.providers.InfuraProvider.getWebSocketProvider();
}


function getTime() {
    return Math.trunc((new Date()).getTime() / 1000);
}

(async function() {
    console.log("Starting...");

    const txsDb = level(resolve(__dirname, "../database/txs.rdb"));
    const blocksDb = level(resolve(__dirname, "../database/blocks.rdb"));

    let canaryTimer = getTime();
    function resetCanary() {
        canaryTimer = getTime();
    }

    // Track how many pending transactions accumulate per block
    let pendingCount = 0;

    // Track the time each pending tx is seen
    provider.on("pending", (hash) => {
        resetCanary();

        const now = String(getTime());
        try {
            txsDb.put(hash, now);
            pendingCount++;
        } catch(error) {
            console.log(`Error (txs.put(${ hash }, ${ now })):`, error.message);
        }
    });

    // On each block, fill in the transaction details
    provider.on("block", async (blockNumber) => {
        resetCanary();

        const timestamp = getTime();

        const txs = [ ];

        const block = await provider.getBlockWithTransactions(blockNumber);
        for (let i = 0; i < block.transactions.length; i++) {

            // Do we have a matching seen tx?
            const tx = block.transactions[i];
            const hash = tx.hash;

            // When did we see this transaction? (if we did)
            let seenTime = null;
            try {
                seenTime = parseInt(await txsDb.get(hash));
            } catch (error) {
                if (error.type !== "NotFoundError") {
                    console.log(`Error (txs.get(${ hash })):`, error.message);
                    continue;
                }
                txs.push({ u: 1 });                                // unseen
                continue
            }

            // Add the transaction details
            const delta = timestamp - seenTime;
            txs.push({
                w: delta,                                          // waitDuration

                d: ethers.utils.hexDataLength(tx.data),            // dataLength
                l: tx.gasLimit.toString(),                         // gasLimit
                p: ethers.utils.formatUnits(tx.gasPrice, "gwei"),  // gasPrice
                v: ethers.utils.formatUnits(tx.value)              // value
            });
        }

        // Pad the blockTag so sorting works
        const blockTag = ethers.utils.hexZeroPad(ethers.utils.hexValue(blockNumber), 4);

        // Store this block info
        blocksDb.put(blockTag, JSON.stringify({ d: timestamp, t: txs }));

        console.log(`Block: #${ blockNumber } (${ block.transactions.length } transactions; ${ txs.filter((b) => b.u).length } unseen; +${ pendingCount } pending)`);
        pendingCount = 0;
    });

    function runPurge(dbName, db, timestampFunc) {
        const now = getTime();

        let retained = 0;

        const ops = [ ];

        const reader = db.createReadStream();

        reader.on("data", ({ key, value }) => {
            const delta = now - timestampFunc(value);
            if (delta > MAX_AGE) {
                ops.push({ type: "del", key: key });
            } else {
                retained++;
            }
        });

        reader.on("error", (error) => {
            console.log(`Error (${ dbName }.purge):`, error.message);
        });

        reader.on("end", async () => {
            console.log(`Prunning (${ dbName }): ${ retained } retained, ${ ops.length } purged`);

            try {
                await db.batch(ops);
            } catch (error) {
                console.log(`Error (${ dbName }.del):`, error.message);
            }

            (setTimeout(() => {
                runPurge(dbName, db, timestampFunc);
            }, PURGE_PERIOD * 1000)).unref();
        });
    }

    // Purge transactions periodically (check every PURGE_PERIOD)
    runPurge("txs", txsDb, parseInt);

    // Purge blocks periodically (check every PURGE_PERIOD, stagger with purging txs)
    (setTimeout(() => {
        runPurge("blocks", blocksDb, ((v) => (JSON.parse(v).d)));
    }, (PURGE_PERIOD * 1000) / 2)).unref();

    // Dump the gas-price.json statistics
    async function runDump() {
        const prices = await getGasPrices();
        console.log("Dump: saving gas-price.json");

        const temp = resolve(__dirname, "../database/.gas-price.json");
        const final = resolve(__dirname, "../database/gas-price.json");
        fs.writeFileSync(temp, JSON.stringify(prices));
        fs.renameSync(temp, final);

        setTimeout(runDump, DUMP_PERIOD * 1000).unref();
    }
    runDump();

    // Canary scanning (check every second)
    // If we go too long without a ne block or a new transaction, it indicates the
    // underlying connection to a backend has probalby disconnected. By exiting,
    // we give our process manager a change to run us again to reconnect
    (setInterval(() => {
        const delta = getTime() - canaryTimer;
        if (delta > MAX_DISCONNECT) {
            console.log(`Canary: forcing restart...`);
            process.exit();
        }
    }, 1000)).unref();

})();
