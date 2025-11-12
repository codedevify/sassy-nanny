require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const nodemailer = require('nodemailer');
const paypal = require('@paypal/checkout-server-sdk');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== MongoDB Models =====
const Booking = mongoose.model('Booking', new mongoose.Schema({
  name: String,
  email: String,
  children: String,
  price: Number,
  day: String,
  time: String,
  service: String,
  paymentMethod: String,
  paymentId: String,
  status: { type: String, default: 'Pending' },
  createdAt: { type: Date, default: Date.now }
}));

const Blog = mongoose.model('Blog', new mongoose.Schema({
  title: String,
  content: String,
  createdAt: { type: Date, default: Date.now }
}));

const AdminConfig = mongoose.model('AdminConfig', new mongoose.Schema({
  paypalClientId: String,
  paypalSecret: String,
  stripeSecretKey: String,
  stripePublishableKey: String,
  gmailUser: String,
  gmailAppPass: String,
  adminEmail: String
}, { collection: 'adminconfig' }));

// ===== Global Config =====
let adminConfig = {
  paypalClientId: '', paypalSecret: '',
  stripeSecretKey: '', stripePublishableKey: '',
  gmailUser: '', gmailAppPass: '', adminEmail: ''
};

let transporter = null;

// CORRECT: createTransport (not createTransporter)
function updateTransporter() {
  if (adminConfig.gmailUser && adminConfig.gmailAppPass) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: adminConfig.gmailUser,
        pass: adminConfig.gmailAppPass
      }
    });
    console.log('Gmail transporter created');
  } else {
    console.log('Gmail credentials missing — email disabled');
  }
}

// PayPal Environment
function paypalEnvironment() {
  const clientId = adminConfig.paypalClientId || process.env.PAYPAL_CLIENT_ID;
  const clientSecret = adminConfig.paypalSecret || process.env.PAYPAL_SECRET;
  if (!clientId || !clientSecret) return null;
  return new paypal.core.SandboxEnvironment(clientId, clientSecret);
}

// ===== MongoDB & Server Start =====
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('MongoDB connected');

    const config = await AdminConfig.findOne();
    if (config) {
      adminConfig = config._doc;
      updateTransporter();
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server LIVE on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB failed:', err);
    process.exit(1);
  });

// ===== Routes =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'blog.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ===== Blog API =====
app.get('/api/blogs', async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 });
    res.json(blogs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/blogs', async (req, res) => {
  const { title, content, password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  const blog = new Blog({ title, content });
  await blog.save();
  res.json(blog);
});

app.delete('/api/blogs/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  await Blog.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ===== Bookings API =====
app.get('/api/bookings', async (req, res) => {
  const bookings = await Booking.find().sort({ createdAt: -1 });
  res.json(bookings);
});

app.post('/api/bookings', async (req, res) => {
  const booking = new Booking(req.body);
  await booking.save();

  // Send emails for all methods except PayPal (PayPal sends on capture)
  if (req.body.paymentMethod !== 'paypal') {
    await sendEmails(booking);
  }

  res.json(booking);
});

app.delete('/api/bookings/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  await Booking.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ===== Admin Config =====
app.get('/api/admin/config', (req, res) => res.json(adminConfig));

app.post('/api/admin/config', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });

  await AdminConfig.deleteMany({});
  const config = new AdminConfig(req.body);
  await config.save();
  adminConfig = config._doc;
  updateTransporter();
  res.json({ success: true });
});

// ===== Stripe =====
app.post('/api/payment/stripe', async (req, res) => {
  const { amount } = req.body;
  if (!adminConfig.stripeSecretKey) return res.status(400).json({ error: 'Stripe not set' });

  const Stripe = require('stripe');
  const stripe = Stripe(adminConfig.stripeSecretKey);
  try {
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd'
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PayPal: Create Order =====
app.post('/api/payment/paypal', async (req, res) => {
  const { amount } = req.body;
  const env = paypalEnvironment();
  if (!env) return res.status(400).json({ error: 'PayPal not configured' });

  const client = new paypal.core.PayPalHttpClient(env);
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: 'USD', value: amount.toFixed(2) },
      description: 'Sassy Nanny Booking'
    }]
  });

  try {
    const order = await client.execute(request);
    res.json({ orderID: order.result.id });
  } catch (err) {
    console.error('PayPal Create Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== PayPal: Capture & Send Email =====
app.post('/api/payment/paypal/capture', async (req, res) => {
  const { orderID, bookingData } = req.body;
  if (!orderID) return res.status(400).json({ error: 'Missing order ID' });

  const env = paypalEnvironment();
  if (!env) return res.status(400).json({ error: 'PayPal not configured' });

  const client = new paypal.core.PayPalHttpClient(env);
  const request = new paypal.orders.OrdersCaptureRequest(orderID);
  request.requestBody({});

  try {
    const capture = await client.execute(request);
    if (capture.result.status === 'COMPLETED') {
      // Save booking if passed from frontend
      if (bookingData) {
        const booking = new Booking({ ...bookingData, paymentId: orderID, status: 'Paid' });
        await booking.save();
        await sendEmails(booking);
      }
      res.json({ success: true, capture: capture.result });
    } else {
      res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (err) {
    console.error('PayPal Capture Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== PayPal Pages =====
app.get('/paypal-success', (req, res) => {
  res.send(`
    <h1>Payment Successful!</h1>
    <p>Check your email for confirmation.</p>
    <a href="/">Back to Home</a>
  `);
});

app.get('/paypal-cancel', (req, res) => {
  res.send(`<h1>Payment Cancelled</h1><a href="/">Try Again</a>`);
});

// ===== EMAIL SENDER (NOW WORKS) =====
async function sendEmails(booking) {
  if (!transporter || !adminConfig.gmailUser || !adminConfig.adminEmail) {
    console.log('Email skipped: missing config or transporter');
    return;
  }

  const customerMail = {
    from: `"Sassy Nanny" <${adminConfig.gmailUser}>`,
    to: booking.email,
    subject: `Booking Confirmed - ${booking.service}`,
    html: `
      <h2>Booking Confirmed!</h2>
      <p><strong>Name:</strong> ${booking.name}</p>
      <p><strong>Service:</strong> ${booking.service}</p>
      <p><strong>Date:</strong> ${booking.day} at ${booking.time}</p>
      <p><strong>Price:</strong> $${booking.price}</p>
      <p>Thank you for choosing <strong>Sooo NOT The Nanny</strong>!</p>
    `
  };

  const adminMail = {
    from: `"New Booking" <${adminConfig.gmailUser}>`,
    to: adminConfig.adminEmail,
    subject: `NEW BOOKING: ${booking.service}`,
    html: `
      <h2>New Booking!</h2>
      <p><strong>Customer:</strong> ${booking.name}</p>
      <p><strong>Email:</strong> ${booking.email}</p>
      <p><strong>Service:</strong> ${booking.service}</p>
      <p><strong>Kids:</strong> ${booking.children}</p>
      <p><strong>Price:</strong> $${booking.price}</p>
      <p><strong>Date:</strong> ${booking.day} | <strong>Time:</strong> ${booking.time}</p>
      <p><strong>Payment:</strong> ${booking.paymentMethod.toUpperCase()}</p>
    `
  };

  try {
    await transporter.sendMail(customerMail);
    console.log(`Customer email sent to ${booking.email}`);
  } catch (err) {
    console.error('Customer email failed:', err.message);
  }

  try {
    await transporter.sendMail(adminMail);
    console.log(`Admin email sent to ${adminConfig.adminEmail}`);
  } catch (err) {
    console.error('Admin email failed:', err.message);
  }
}
