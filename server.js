require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs'); // NEW: needed to read/write bookings.json
const Razorpay = require('razorpay');

// Validate required env vars at startup so server fails loudly, not silently
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error("FATAL: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env");
    process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// NEW: path to the bookings file sitting next to server.js
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

// NEW: load existing bookings from disk on startup (so bookings survive restarts)
let bookedSlotsDatabase = {};
if (fs.existsSync(BOOKINGS_FILE)) {
    try {
        const raw = fs.readFileSync(BOOKINGS_FILE, 'utf8');
        bookedSlotsDatabase = JSON.parse(raw);
        console.log("Bookings loaded from bookings.json ✅");
    } catch (err) {
        console.error("Could not parse bookings.json, starting fresh:", err);
        bookedSlotsDatabase = {};
    }
}

// NEW: helper — saves the current database to bookings.json after every booking
function saveBookings() {
    try {
        fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookedSlotsDatabase, null, 2), 'utf8');
    } catch (err) {
        console.error("Failed to save bookings.json:", err);
    }
}

app.get('/api/bookings', (req, res) => {
    res.json({ success: true, database: bookedSlotsDatabase });
});

app.post('/api/payments/order', async (req, res) => {
    const { date, time, duration } = req.body;
    if (!date || !time || !duration) {
        return res.status(400).json({ success: false, message: "Missing date, time, or duration." });
    }

    try {
        const options = {
            amount: 5000, // ₹50 in paise
            currency: "INR",
            receipt: `receipt_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);

        res.json({
            success: true,
            order_id: order.id,
            amount: options.amount,
            key_id: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error("Razorpay order creation failed:", error);
        res.status(500).json({ success: false, message: "Could not create order." });
    }
});

app.post('/api/payments/verify', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingDetails } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !bookingDetails) {
        return res.status(400).json({ success: false, message: "Missing payment verification fields." });
    }

    const { date, time, duration } = bookingDetails;
    if (!date || !time || !duration) {
        return res.status(400).json({ success: false, message: "Missing booking details." });
    }

    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSign = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(sign)
        .digest("hex");

    if (razorpay_signature !== expectedSign) {
        return res.status(400).json({ success: false, message: "Signature verification failed." });
    }

    // Parse time string e.g. "5:30 PM"
    const [hourStr, rest] = time.split(':');
    const minutePart = rest.split(' ')[0];
    const ampm = rest.split(' ')[1];

    let startHour = parseInt(hourStr);
    const startMin = parseInt(minutePart);

    if (ampm === 'PM' && startHour !== 12) startHour += 12;
    else if (ampm === 'AM' && startHour === 12) startHour = 0;

    // Correctly compute end time for fractional durations (1.5h = 1h 30m etc.)
    const durationFloat = parseFloat(duration);
    const totalStartMinutes = startHour * 60 + startMin;
    const totalEndMinutes = totalStartMinutes + Math.round(durationFloat * 60);
    const endHour = Math.floor(totalEndMinutes / 60);
    const endMin = totalEndMinutes % 60;

    if (!bookedSlotsDatabase[date]) {
        bookedSlotsDatabase[date] = [];
    }

    // Check for overlapping booking before saving
    const newStart = totalStartMinutes;
    const newEnd = totalEndMinutes;
    const hasOverlap = bookedSlotsDatabase[date].some(booking => {
        const existingStart = booking.startHour * 60 + booking.startMin;
        const existingEnd = booking.endHour * 60 + booking.endMin;
        return newStart < existingEnd && newEnd > existingStart;
    });

    if (hasOverlap) {
        return res.status(409).json({ success: false, message: "This slot has already been booked. Please choose another time." });
    }

    bookedSlotsDatabase[date].push({ startHour, startMin, endHour, endMin });

    // NEW: save to disk immediately after every successful booking
    saveBookings();

    res.json({ success: true, message: "Payment verified and slot booked." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Yoru Turf server running on port ${PORT}`);
});
