require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const nodemailer = require('nodemailer');
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve public folder

// ===== MongoDB Models =====
const Booking = mongoose.model('Booking', new mongoose.Schema({
  name: String, email: String, children: String, price: Number,
  day: String, time: String, service: String,
  paymentMethod: String, paymentId: String,
  status: { type: String, default: 'Pending' },
  createdAt: { type: Date, default: Date.now }
}));

const Blog = mongoose.model('Blog', new mongoose.Schema({
  title: String, content: String,
  createdAt: { type: Date, default: Date.now }
}));

const AdminConfig = mongoose.model('AdminConfig', new mongoose.Schema({
  paypalClientId: String, paypalSecret: String,
  stripeSecretKey: String, stripePublishableKey: String,
  adminEmail: String, gmailUser: String, gmailAppPass: String
}, { collection: 'adminconfig' }));

// ===== Global Config =====
let adminConfig = {
  paypalClientId: '', paypalSecret: '', stripeSecretKey: '', stripePublishableKey: '',
  adminEmail: '', gmailUser: '', gmailAppPass: ''
};
let transporter = null;

function updateTransporter() {
  if (adminConfig.gmailUser && adminConfig.gmailAppPass) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: adminConfig.gmailUser, pass: adminConfig.gmailAppPass }
    });
  }
}

// ===== MongoDB Connection =====
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('MongoDB connected');

    // Load config
    const config = await AdminConfig.findOne();
    if (config) {
      adminConfig = config._doc;
      updateTransporter();
    }

    // Start server AFTER DB
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server LIVE on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB Error:', err);
    process.exit(1);
  });

// ===== Routes =====

// Serve HTML pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// === Blog API ===
app.get('/api/blogs', async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 });
    res.json(blogs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/blogs', async (req, res) => {
  const { title, content, password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  const blog = new Blog({ title, content });
  await blog.save();
  res.json(blog);
});

app.delete('/api/blogs/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  await Blog.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// === Bookings API ===
app.get('/api/bookings', async (req, res) => {
  const bookings = await Booking.find().sort({ createdAt: -1 });
  res.json(bookings);
});

app.delete('/api/bookings/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  await Booking.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.post('/api/bookings', async (req, res) => {
  const booking = new Booking(req.body);
  await booking.save();

  if (req.body.paymentMethod !== 'paypal') {
    await sendEmails(booking);
  }
  res.json(booking);
});

// === Admin Config ===
app.get('/api/admin/config', (req, res) => {
  res.json(adminConfig);
});

app.post('/api/admin/config', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }

  await AdminConfig.deleteMany({});
  const config = new AdminConfig(req.body);
  await config.save();
  adminConfig = config._doc;
  updateTransporter();
  res.json({ success: true });
});

// === Stripe Payment ===
app.post('/api/payment/stripe', async (req, res) => {
  const { amount } = req.body;
  if (!adminConfig.stripeSecretKey) {
    return res.status(400).json({ error: 'Stripe not set' });
  }

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

// === Email Helper ===
async function sendEmails(booking) {
  if (!transporter || !adminConfig.adminEmail) return;

  const customer = {
    from: adminConfig.gmailUser,
    to: booking.email,
    subject: `Booking Confirmed - ${booking.service}`,
    html: `<h2>Confirmed!</h2><p>Service: ${booking.service}</p><p>Date: ${booking.day} ${booking.time}</p>`
  };

  const admin = {
    from: adminConfig.gmailUser,
    to: adminConfig.adminEmail,
    subject: `NEW BOOKING: ${booking.service}`,
    html: `<h2>New Booking</h2><p>Name: ${booking.name}</p><p>Service: ${booking.service}</p>`
  };

  try { await transporter.sendMail(customer); } catch (e) { console.error(e); }
  try { await transporter.sendMail(admin); } catch (e) { console.error(e); }
}
