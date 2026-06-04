const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const razorpay = new Razorpay({
    key_id: 'rzp_test_YOUR_KEY_ID', 
    key_secret: 'YOUR_KEY_SECRET'
});

const bookedSlotsDatabase = {};

app.post('/api/payments/order', async (req, res) => {
    try {
        const { date, time, duration } = req.body;

        const options = {
            amount: 5000, 
            currency: "INR",
            receipt: `receipt_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);
        
        res.json({
            success: true,
            order_id: order.id,
            amount: options.amount,
            key_id: razorpay.key_id
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Could not create order" });
    }
});

app.post('/api/payments/verify', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingDetails } = req.body;

    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSign = crypto
        .createHmac("sha256", razorpay.key_secret)
        .update(sign.toString())
        .digest("hex");

    if (razorpay_signature === expectedSign) {
        const { date, time, duration } = bookingDetails;
        if (!bookedSlotsDatabase[date]) {
            bookedSlotsDatabase[date] = [];
        }
        
        const [hourStr, minStr] = time.split(':');
        let startHour = parseInt(hourStr);
        const startMin = parseInt(minStr.split(' ')[0]);
        const ampm = minStr.split(' ')[1];

        if (ampm === 'PM' && startHour !== 12) {
            startHour += 12;
        } else if (ampm === 'AM' && startHour === 12) {
            startHour = 0;
        }

        const endHour = startHour + Math.floor(parseFloat(duration));
        
        bookedSlotsDatabase[date].push({
            startHour,
            startMin,
            endHour,
            endMin: startMin
        });

        res.json({ success: true, message: "Payment verified" });
    } else {
        res.status(400).json({ success: false, message: "Verification failed" });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});