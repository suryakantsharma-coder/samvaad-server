const Hospital = require("../../models/hospital.model");
const PaymentTransaction = require("../../models/paymentTransaction.model");
const PayoutList = require("../../models/payoutList.model");
const env = require("../../config/env");
const { getLastMonthRange, getCurrentMonthRange } = require("./getLastMonthRange");

function payoutCronUsesCurrentMonth() {
  const v = String(env.PAYOUT_CRON_USE_CURRENT_MONTH || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Aggregates captured PaymentTransaction rows for the previous calendar month per hospital (default),
 * or the **current** month when `PAYOUT_CRON_USE_CURRENT_MONTH=1` (testing only).
 * Uses razorpayCreatedAt when set, otherwise createdAt, for month bucketing; only rows with createdAt <= runAt are included (hourly incremental snapshot).
 */
async function runHourlyPayoutJob() {
  const jobStarted = Date.now();
  console.log("[HourlyPayout] Job: start");

  const runAt = new Date();
  console.log(`[HourlyPayout] Job: runAt=${runAt.toISOString()}`);

  const useCurrentMonth = payoutCronUsesCurrentMonth();
  if (useCurrentMonth) {
    console.warn(
      "[HourlyPayout] Job: PAYOUT_CRON_USE_CURRENT_MONTH is set — using **current** month (testing); unset for production"
    );
    console.log("[HourlyPayout] Job: computing range via getCurrentMonthRange()");
  } else {
    console.log("[HourlyPayout] Job: computing range via getLastMonthRange() (previous month)");
  }
  const { start: periodStart, end: periodEnd } = useCurrentMonth
    ? getCurrentMonthRange()
    : getLastMonthRange();
  console.log(`[HourlyPayout] Job: periodStart=${periodStart.toISOString()} periodEnd=${periodEnd.toISOString()}`);
  console.log(
    "[HourlyPayout] Job: new payout rows get status=draft ($setOnInsert); existing rows keep status (e.g. paid)"
  );

  console.log("[HourlyPayout] Job: querying active hospitals (isActive: true)…");
  const hospitals = await Hospital.find({ isActive: true }).select("_id name").lean();
  console.log(`[HourlyPayout] Job: loaded ${hospitals.length} hospital(s)`);
  hospitals.forEach((h, i) => {
    console.log(`[HourlyPayout] Job:   hospital[${i}] _id=${h._id} name="${h.name}"`);
  });

  console.log("[HourlyPayout] Job: running PaymentTransaction aggregate (captured, in period, createdAt <= runAt)…");
  const sums = await PaymentTransaction.aggregate([
    {
      $match: {
        hospital: { $exists: true, $ne: null },
        createdAt: { $lte: runAt },
        $expr: {
          $and: [
            { $eq: [{ $toLower: { $ifNull: ["$razorpayStatus", ""] } }, "captured"] },
            {
              $gte: [
                { $ifNull: ["$razorpayCreatedAt", "$createdAt"] },
                periodStart,
              ],
            },
            {
              $lte: [
                { $ifNull: ["$razorpayCreatedAt", "$createdAt"] },
                periodEnd,
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$hospital",
        totalPrice: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
  ]);

  console.log(`[HourlyPayout] Job: aggregate returned ${sums.length} hospital group(s) with captured payments`);
  sums.forEach((row, i) => {
    console.log(
      `[HourlyPayout] Job:   sum[${i}] hospitalId=${row._id} totalPrice=${row.totalPrice}`
    );
  });

  const totalByHospital = new Map(
    sums.map((row) => [String(row._id), row.totalPrice])
  );

  console.log("[HourlyPayout] Job: upserting PayoutList per hospital…");
  let upsertIndex = 0;
  for (const h of hospitals) {
    const hid = String(h._id);
    const totalPrice = totalByHospital.get(hid) || 0;

    console.log(
      `[HourlyPayout] Job: upsert [${upsertIndex + 1}/${hospitals.length}] hospitalId=${h._id} name="${h.name}" totalPrice=${totalPrice}`
    );

    const doc = await PayoutList.findOneAndUpdate(
      { hospitalId: h._id, startDate: periodStart, endDate: periodEnd },
      {
        $set: {
          hospitalName: h.name,
          hospitalId: h._id,
          createdDate: runAt,
          totalPrice,
          startDate: periodStart,
          endDate: periodEnd,
        },
        $setOnInsert: { status: "draft" },
      },
      { upsert: true, new: true }
    );

    const lastMod = doc.updatedAt ? doc.updatedAt.toISOString() : "n/a";
    console.log(
      `[HourlyPayout] Job:   saved payoutList _id=${doc._id} status=${doc.status} updatedAt=${lastMod}`
    );
    upsertIndex += 1;
  }

  const elapsedMs = Date.now() - jobStarted;
  console.log(`[HourlyPayout] Job: complete in ${elapsedMs}ms`);

  return {
    hospitals: hospitals.length,
    periodStart,
    periodEnd,
    runAt,
  };
}

module.exports = { runHourlyPayoutJob };
