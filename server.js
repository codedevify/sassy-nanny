require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const nodemailer = require('nodemailer');
const paypal = require('paypal-rest-sdk');
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

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
  adminEmail: String,
  gmailUser: String,
  gmailAppPass: String
}, { collection: 'adminconfig' }));

// ===== Initial Config =====
let adminConfig = { 
  paypalClientId: '', paypalSecret: '', 
  stripeSecretKey: '', stripePublishableKey: '',
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
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(async () => {
  console.log('✅ MongoDB connected');

  // Load admin config AFTER DB connection
  const config = await AdminConfig.findOne();
  if (config) {
    adminConfig = config;
    if (config.paypalClientId && config.paypalSecret) {
      paypal.configure({
        mode: 'sandbox',
        client_id: config.paypalClientId,
        client_secret: config.paypalSecret,
      });
    }
    updateTransporter();
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
})
.catch(err => console.error('❌ MongoDB connection error:', err));

// ===== Routes =====

// Static Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'blog.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// === Blog API ===
app.get('/api/blogs', async (req, res) => {
  const blogs = await Blog.find().sort({ createdAt: -1 });
  res.json(blogs);
});

app.post('/api/blogs', async (req, res) => {
  const { title, content, password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Unauthorized' });

  const blog = new Blog({ title, content });
  await blog.save();
  res.json(blog);
});

app.delete('/api/blogs/:id', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Unauthorized' });

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
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Unauthorized' });

  await Booking.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// === Admin Config API ===
app.post('/api/admin/config', async (req, res) => {
  const { password, paypalClientId, paypalSecret, stripeSecretKey, stripePublishableKey, adminEmail, gmailUser, gmailAppPass } = req.body;
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Unauthorized' });

  await AdminConfig.deleteMany({});
  const config = new AdminConfig({ paypalClientId, paypalSecret, stripeSecretKey, stripePublishableKey, adminEmail, gmailUser, gmailAppPass });
  await config.save();
  adminConfig = config;

  if (paypalClientId && paypalSecret) {
    paypal.configure({ mode: 'sandbox', client_id: paypalClientId, client_secret: paypalSecret });
  }
  updateTransporter();
  res.json({ success: true });
});

app.get('/api/admin/config', async (req, res) => {
  res.json(adminConfig);
});

// === Stripe Payments ===
app.post('/api/payment/stripe', async (req, res) => {
  const { amount } = req.body;
  if (!adminConfig.stripeSecretKey)
    return res.status(400).json({ error: 'Stripe not configured' });

  const Stripe = require('stripe');
  const stripe = Stripe(adminConfig.stripeSecretKey);
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100,
      currency: 'usd'
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === PayPal Payments ===
app.post('/api/payment/paypal', (req, res) => {
  const { amount } = req.body;
  if (!adminConfig.paypalClientId)
    return res.status(400).json({ error: 'PayPal not configured' });

  const create_payment_json = {
    intent: 'sale',
    payer: { payment_method: 'paypal' },
    redirect_urls: {
      return_url: `https://${req.headers.host}/success`,
      cancel_url: `https://${req.headers.host}/cancel`
    },
    transactions: [{ amount: { total: amount.toFixed(2), currency: 'USD' } }]
  };

  paypal.payment.create(create_payment_json, (error, payment) => {
    if (error) return res.status(500).json({ error: error.message });
    for (let link of payment.links) {
      if (link.rel === 'approval_url') return res.json({ forwardLink: link.href });
    }
  });
});

app.get('/success', async (req, res) => {
  const payerId = req.query.PayerID;
  const paymentId = req.query.paymentId;
  const execute_payment_json = { payer_id: payerId };

  paypal.payment.execute(paymentId, execute_payment_json, async (error, payment) => {
    if (error) return res.send('Payment failed');

    const booking = await Booking.findOneAndUpdate(
      { paymentId },
      { status: 'Paid' },
      { new: true }
    );

    if (booking) await sendEmails(booking);

    res.send('<h1>Payment Successful!</h1><p>Check your email.</p>');
  });
});

app.get('/cancel', (req, res) => res.send('Payment cancelled.'));

// === Booking Creation with Email ===
app.post('/api/bookings', async (req, res) => {
  const { name, email, children, day, time, service, paymentMethod, paymentId, price } = req.body;
  
  const booking = new Booking({
    name, email, children, price, day, time, service, paymentMethod, paymentId
  });
  
  await booking.save();

  if (paymentMethod !== 'paypal') {
    await sendEmails(booking);
  }

  res.json(booking);
});

// === Email Sending Helper ===
async function sendEmails(booking) {
  if (!transporter || !adminConfig.adminEmail || !adminConfig.gmailUser) return;

  const customerMail = {
    from: adminConfig.gmailUser,
    to: booking.email,
    subject: `Booking Confirmed - ${booking.service}`,
    html: `
      <h2>Booking Confirmed!</h2>
      <p><strong>Name:</strong> ${booking.name}</p>
      <p><strong>Service:</strong> ${booking.service}</p>
      <p><strong>Price:</strong> $${booking.price}</p>
      <p><strong>Date:</strong> ${booking.day} at ${booking.time}</p>
      <p>Thank you for choosing Sooo NOT The Nanny!</p>
    `
  };

  const adminMail = {
    from: adminConfig.gmailUser,
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
      <p><strong>Status:</strong> ${booking.status}</p>
    `
  };

  try { await transporter.sendMail(customerMail); } 
  catch (err) { console.error('Customer email failed:', err); }

  try { await transporter.sendMail(adminMail); } 
  catch (err) { console.error('Admin email failed:', err); }
}
