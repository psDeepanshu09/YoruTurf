require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Razorpay = require('razorpay');

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

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

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

// Migrate any old unpadded keys (e.g. "2026-6-7") to padded format ("2026-06-07")
const migratedDb = {};
Object.entries(bookedSlotsDatabase).forEach(([key, val]) => {
    const normalized = key.replace(/-(\d)(?=-|$)/g, (_, d) => `-0${d}`);
    migratedDb[normalized] = val;
});
bookedSlotsDatabase = migratedDb;

// Save database to disk
function saveBookings() {
    try {
        fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookedSlotsDatabase, null, 2), 'utf8');
    } catch (err) {
        console.error("Failed to save bookings.json:", err);
    }
}

// Normalize date keys to always be YYYY-MM-DD (padded) so live-slots.html lookup never misses
function normalizeDate(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    return `${y}-${String(parseInt(m)).padStart(2, '0')}-${String(parseInt(d)).padStart(2, '0')}`;
}

// Admin password (same as admin.html)
const ADMIN_PASSWORD = 'kaitops#hinata';

app.get('/api/bookings', (req, res) => {
    res.json({ success: true, database: bookedSlotsDatabase });
});

app.post('/api/payments/order', async (req, res) => {
    const { date, time, duration, name, phone } = req.body;
    if (!date || !time || !duration) {
        return res.status(400).json({ success: false, message: "Missing date, time, or duration." });
    }
    // NEW: validate name and phone are present
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: "Player name is required." });
    }
    if (!phone || !/^\d{10}$/.test(phone.trim())) {
        return res.status(400).json({ success: false, message: "Valid 10-digit phone number is required." });
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

    const { time, duration, name, phone } = bookingDetails;
    const date = normalizeDate(bookingDetails.date);
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

    const durationFloat = parseFloat(duration);
    const totalStartMinutes = startHour * 60 + startMin;
    const totalEndMinutes = totalStartMinutes + Math.round(durationFloat * 60);
    const endHour = Math.floor(totalEndMinutes / 60);
    const endMin = totalEndMinutes % 60;

    if (!bookedSlotsDatabase[date]) {
        bookedSlotsDatabase[date] = [];
    }

    // Check for overlapping booking
    const hasOverlap = bookedSlotsDatabase[date].some(booking => {
        const existingStart = booking.startHour * 60 + booking.startMin;
        const existingEnd = booking.endHour * 60 + booking.endMin;
        return totalStartMinutes < existingEnd && totalEndMinutes > existingStart;
    });

    if (hasOverlap) {
        return res.status(409).json({ success: false, message: "This slot has already been booked. Please choose another time." });
    }

    // NEW: save name and phone alongside slot data
    bookedSlotsDatabase[date].push({
        startHour,
        startMin,
        endHour,
        endMin,
        name: name ? name.trim() : '',
        phone: phone ? phone.trim() : ''
    });

    saveBookings();

    res.json({ success: true, message: "Payment verified and slot booked." });
});

// NEW: Admin cancel booking route
app.post('/api/admin/cancel', (req, res) => {
    const { dateKey, idx, password } = req.body;

    // Verify admin password
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    if (!dateKey || idx === undefined || idx === null) {
        return res.status(400).json({ success: false, message: "Missing dateKey or idx." });
    }

    const normalizedKey = normalizeDate(dateKey);
    if (!bookedSlotsDatabase[normalizedKey]) {
        return res.status(404).json({ success: false, message: "No bookings found for this date." });
    }

    const idx_num = parseInt(idx);
    if (isNaN(idx_num) || idx_num < 0 || idx_num >= bookedSlotsDatabase[normalizedKey].length) {
        return res.status(400).json({ success: false, message: "Invalid booking index." });
    }

    // Remove the booking at that index
    bookedSlotsDatabase[normalizedKey].splice(idx_num, 1);

    // Clean up empty date keys
    if (bookedSlotsDatabase[normalizedKey].length === 0) {
        delete bookedSlotsDatabase[normalizedKey];
    }

    saveBookings();

    res.json({ success: true, message: "Booking cancelled successfully." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Yoru Turf server running on port ${PORT}`);
});
