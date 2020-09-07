"use strict";

const { resolve } = require("path");

const { ethers } = require("ethers");

const level = require("level-rocksdb");

/**
 *  Idea
 *   - Trim off the lowest price with the fastest time and
 *     highest price with the slowest times until 80% of the
 *     data is represetned; these are outliers
 *
 */

function _stdDev(data, result, skip) {
    let divisor = result.count - 1;
    return Math.sqrt(data.reduce((accum, v, index) => {
        if (index === skip) {
            divisor--;
            return accum;
        }
        const dx = (v - result.mean);
        accum += dx * dx;
        return accum;
    }, 0) / divisor);
}

// Data must be sorted
function getStats(data) {
    const result = {
        min: null,
        max: null,
        sum: 0,
        count: data.length,
        mean: null,
        median: data[Math.trunc(data.length * 0.5)],
        tp90: data[Math.trunc(data.length * 0.8)],
        stdDev: null,
        target90: null
    };

    data.forEach((value) => {
        result.sum += value;
        if (result.min == null || value < result.min) { result.min = value; }
        if (result.max == null || value > result.min) { result.max = value; }
    });

    result.mean = result.sum / result.count;

    result.stdDev = _stdDev(data, result, -1);

    {
        let target = data.slice();
        const nix = Math.trunc(0.31 * target.length);
        let bestRem = null;
        for (let i = 0; i < nix; i++) {
            const remLow = _stdDev(target, result, 0);
            const remHigh = _stdDev(target, result, target.length - 1);

            if (remLow < remHigh) {
                target = target.slice(1);
                bestRem = remLow;
            } else if (remLow > remHigh) {
                target = target.slice(0, target.length - 1);
                bestRem = remHigh;
            } else {
                if (i & 2) {
                    target = target.slice(1);
                    bestRem = remLow;
                } else {
                    target = target.slice(0, target.length - 1);
                    bestRem = remHigh;
                }
            }
        }
        result.targetStdDev = bestRem;
        result.target90 = target[Math.trunc(target.length * 0.9)];
        result.targetCount = target.length;
        result.targetBest = target[0];
        result.targetWorst = target[target.length - 1];
    }

    return result;
}

function getBlocks(count) {
    if (count == null) { count = 200; }

    const result = [ ];

    const blocksDb = level(resolve(__dirname, "../database/blocks.rdb"), { readOnly: true });
    return new Promise((resolve, reject) => {

        const reader = blocksDb.createReadStream({
            reverse: true,
            limit: count
        });

        reader.on("data", ({ key, value }) => {
            value = JSON.parse(value).t;
            result.push({
                blockNumber: ethers.BigNumber.from(key).toNumber(),
                transactions: value.map((tx) => {
                    if (tx.u) { return null; }
                    return {
                        waitDuration: tx.w,
                        dataLength: tx.d,
                        gasPrice: ethers.utils.parseUnits(tx.p, "gwei"),
                        gasLimit: ethers.BigNumber.from(tx.l),
                        value: ethers.utils.parseUnits(tx.v),
                    };
                }).filter(Boolean)
            });
        });

        reader.on("error", (error) => {
            reject(error);
        });

        reader.on("end", () => {
            resolve(result);
        });
    });
}

async function getGasPrices() {
    const blocks = await getBlocks(100);

    const data = {
        slow: [ ],
        medium: [ ],
        fast: [ ],
    };

    //const tally = { };
    blocks.forEach((block) => {
        block.transactions.forEach((tx) => {
            const price = parseFloat(ethers.utils.formatUnits(tx.gasPrice, "gwei"));
            const duration = tx.waitDuration;

            // Anything that takes over an hour is not interesting to us
            if (duration > (60 * 60)) { return; }

            if (duration < (1 * 60)) {
                data.fast.push(price);
            } else if (duration < (5 * 60)) {
                data.medium.push(price);
            } else {
                data.slow.push(price);
            }

        });
    });

    // Sort; needed for getStats
    data.fast.sort((a, b) => (a - b));
    data.medium.sort((a, b) => (a - b));
    data.slow.sort((a, b) => (a - b));

    return {
        blockNumber: (blocks[0] || {}).blockNumber,
        timestamp: ((new Date()).getTime() / 1000),
        slow: getStats(data.slow),
        medium: getStats(data.medium),
        fast: getStats(data.fast),
    };

}

module.exports.getGasPrices = getGasPrices;
