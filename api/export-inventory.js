const XLSX = require("xlsx");
const { getState } = require("./_lib/wheel-state");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const state = await getState();
    const rows = [["Item", "Quantity"]];

    for (const [item, qty] of Object.entries(state.inventory)) {
      rows.push([item, qty]);
    }

    rows.push([]);
    rows.push(["Exported At", new Date().toISOString()]);

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Inventory");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Inventory-Live.xlsx"`);
    res.status(200).send(buffer);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : "Unexpected server error"
    });
  }
};
