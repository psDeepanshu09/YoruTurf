require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs'); 
const Razorpay = require('razorpay');

const app = express();
app.use(express.json());

// 1. Serve all your static HTML/CSS/JS frontend files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// 2. Route to explicitly serve booking.html when a user visits the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});

// 3. Razorpay Initialization with a safety fallback string so Render doesn't crash if keys are missing
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || "PLACEHOLDER_KEY",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "PLACEHOLDER_SECRET"
});

// Path to your bookings storage file
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

// Load existing bookings from disk on startup
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

// Helper to save database to disk
function saveBookings() {
    try {
        fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookedSlotsDatabase, null, 2), 'utf8');
    } catch (err) {
        console.error("Failed to save bookings.json:", err);
    }
}

// API to get all bookings
app.get('/api/bookings', (req, res) => {
    res.json({ success: true, database: bookedSlotsDatabase });
});

// API to create an order
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

// API to verify payments
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
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "PLACEHOLDER_SECRET")
        .update(sign)
        .digest("hex");

    if (razorpay_signature !== expectedSign) {
        return res.status(400).json({ success: false, message: "Signature verification failed." });
    }

    const [hourStr, rest] = time.split(':');
    const minutePart = rest.split(' ')[0];
    const ampm = rest.split(' ')[1];

    let startHour = parseInt(hourStr);
    const startMin = parseInt(minutePart);

    if (ampm === 'PM' && startHour !== 12) startHour += 12;
    else if (ampm === 'AM' && startHour === 12) startHour = 0;

    const durationFloat = parseFloat(duration);
    const totalStartMinutes = startHour * 60 + startMin;
    const totalEndMinutes = totalStartMinutes + Math.round(durationFloat * 60);
    const endHour = Math.floor(totalEndMinutes / 60);
    const endMin = totalEndMinutes % 60;

    if (!bookedSlotsDatabase[date]) {
        bookedSlotsDatabase[date] = [];
    }

    const newStart = totalStartMinutes;
    const newEnd = totalEndMinutes;
    const hasOverlap = bookedSlotsDatabase[date].some(booking => {
        const existingStart = booking.startHour * 60 + booking.startMin;
        const existingEnd = booking.endHour * 60 + booking.endMin;
        return newStart < existingEnd && newEnd > existingStart;
    });

    if (hasOverlap) {
        return res.status(409).json({ success: false, message: "This slot has already been booked." });
    }

    bookedSlotsDatabase[date].push({ startHour, startMin, endHour, endMin });
    saveBookings();

    res.json({ success: true, message: "Payment verified and slot booked." });
});

// 4. CRITICAL PORT BINDING FIX FOR RENDER
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Yoru Turf server running on port ${PORT}`);
});