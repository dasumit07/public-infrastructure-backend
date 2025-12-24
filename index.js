require('dotenv').config()
const express = require('express')
const cors = require('cors')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express()
const port = process.env.PORT || 3000
const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// middleware
app.use(express.json())
app.use(cors())

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email
  } catch (error) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  next();
}


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.kfapxri.mongodb.net/?appName=Cluster0`;

function generateTrackingId() {
  return "TRK-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
   

    const db = client.db("issue_reporting_system");
    const issuesCollection = db.collection("issues");
    const paymentsCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const staffCollection = db.collection("staff");

    // middleware
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded_email;

        const user = await userCollection.findOne({ email });

        if (user && user.role === 'admin') {
          return next();
        }

        const staff = await staffCollection.findOne({ email });

        if (staff && staff.role === 'admin') {
          return next();
        }

        return res.status(403).send({ message: 'Forbidden access' });

      } catch (error) {
        console.error('verifyAdmin error:', error);
        res.status(500).send({ message: 'Server error' });
      }
    };
    const verifyStaff = async (req, res, next) => {
      try {
        const email = req.decoded_email;

        const staff = await staffCollection.findOne({ email });

        if (staff && staff.role === 'staff' && staff.status === 'active') {
          return next();
        }

        return res.status(403).send({ message: 'Forbidden access: Not a staff member or inactive' });
      } catch (error) {
        console.error('verifyStaff error:', error);
        res.status(500).send({ message: 'Server error' });
      }
    };
    const verifyUser = async (req, res, next) => {
      try {
        const email = req.decoded_email;

        const user = await userCollection.findOne({ email });

        if (user && user.role === 'user' && user.status === 'active') {
          return next();
        }

        return res.status(403).send({ message: 'Forbidden access: Not a user or inactive' });
      } catch (error) {
        console.error('verifyUser error:', error);
        res.status(500).send({ message: 'Server error' });
      }
    };
    // users api
    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      user.status = 'active';
      user.isPremium = false;
      user.premiumSince = null;
      user.createdAt = new Date();
      const userExits = await userCollection.findOne({ email: user.email });
      if (userExits) {
        return res.send({ message: 'user exits' });
      };
      const result = await userCollection.insertOne(user);
      res.send(result);
    })
    app.get('/users', verifyFBToken, async (req, res) => {
      const result = await userCollection.find({}, { sort: { createdAt: -1 } }).toArray();
      res.send(result);
    });
    app.patch('/users/:id/status', verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      const result = await userCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      res.send(result);
    });
    app.get('/profile', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await userCollection.findOne({ email });
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
      res.send(user);
    });
    app.patch('/profile', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const { displayName, photoURL } = req.body;

      const result = await userCollection.updateOne(
        { email },
        { $set: { displayName, photoURL } }
      );

      res.send(result);
    });
    app.post('/subscribe', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await userCollection.findOne({ email });

      if (user?.status === 'blocked') {
        return res.status(403).send({
          message: 'Your account is blocked. You cannot boost issues.'
        });
      }
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: 787,
              product_data: {
                name: 'Premium Subscription',
              },
            },
            quantity: 1,
          },
        ],
        customer_email: email,
        mode: 'payment',
        success_url: `${process.env.SITE_DOMAIN}/dashboard/profile?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/profile`,
      });

      res.send({ url: session.url });
    });
    app.patch('/subscription-success', async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== 'paid') {
          return res.status(400).send({ message: 'Payment not completed' });
        }

        const transactionId = session.payment_intent;

        const exists = await paymentsCollection.findOne({ transactionId });
        if (exists) {
          return res.send({ message: 'Already processed' });
        }

        await userCollection.updateOne(
          { email: session.customer_email },
          {
            $set: {
              isPremium: true,
              premiumSince: new Date()
            }
          }
        );

        const paymentRecord = {
          amount: session.amount_total / 100,
          currency: session.currency,
          email: session.customer_email,
          name: "Premium Subscription",
          transactionId,
          paymentStatus: session.payment_status,
          paidAt: new Date()
        };

        await paymentsCollection.insertOne(paymentRecord);

        return res.send({ success: true });

      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server error' });
      }
    });
    // role api
    app.get('/role', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;

      const user = await userCollection.findOne({ email });
      if (user) {
        return res.send({
          role: user.role
        });
      }

      const staff = await staffCollection.findOne({ email });
      if (staff) {
        return res.send({
          role: staff.role
        });
      }

      res.status(404).send({ role: 'unknown' });
    })

    // staff api

    app.post('/create-staff', verifyFBToken, async (req, res) => {
      try {
        const { email, password, name, photoURL, phone } = req.body;

        const userRecord = await admin.auth().createUser({
          email,
          password,
          displayName: name,
          photoURL
        });

        await staffCollection.insertOne({
          uid: userRecord.uid,
          email,
          phone,
          name,
          photoURL,
          role: 'staff',
          status: 'active',
          createdAt: new Date()
        });

        res.send({ success: true });
      } catch (error) {
        console.error('Create staff error:', error);
        res.status(400).send({
          success: false,
          message: error.message
        });
      }
    });

    app.get('/staffs', verifyFBToken, async (req, res) => {
      const result = await staffCollection.find({}, { sort: { createdAt: -1 } }).toArray();
      res.send(result);
    });
    app.put('/staff/:id', verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const data = req.body;
      const objectId = new ObjectId(id);
      const update = {
        $set: data
      }
      const result = await staffCollection.updateOne({ _id: objectId }, update);
      res.send(result);
    })
    app.delete('/staff/:id', verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const objectId = new ObjectId(id);
      const result = await staffCollection.deleteOne({ _id: objectId });
      res.send(result);
    })
    app.get('/staff/issues', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const { status, priority } = req.query;

      const query = { 'assignedStaff.email': email };
      if (status) query.status = status;
      if (priority) query.priority = priority;

      const result = await issuesCollection.find(query).sort({ paymentStatus: 1 }).toArray();
      res.send(result);
    });
    app.patch('/staff-profile', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const { displayName, photoURL } = req.body;

      const result = await staffCollection.updateOne(
        { email },
        { $set: { name: displayName, photoURL } }
      );

      res.send(result);
    });
    // issue api
    app.post('/issues', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;

      const user = await userCollection.findOne({ email });

      if (user.status === 'blocked') {
        return res.status(403).send({ message: 'Account blocked' });
      }

      if (!user.isPremium) {
        const issueCount = await issuesCollection.countDocuments({
          reporterEmail: email
        });

        if (issueCount >= 3) {
          return res.status(403).send({
            message: 'Issue limit reached. Please subscribe to premium.'
          });
        }
      }

      const issue = req.body;
      issue.trackingId = generateTrackingId();
      issue.priority = "Normal";
      issue.paymentStatus = "unpaid";
      issue.timeline = [
        {
          action: "ISSUE_REPORTED",
          message: "Issue reported by citizen",
          updatedBy: "Citizen",
          name: issue.reporterName,
          at: new Date()
        }
      ];

      const result = await issuesCollection.insertOne(issue);
      res.send(result);
    });
    app.get('/issues/latest-resolved', async (req, res) => {
      try {
        const result = await issuesCollection
          .find({ status: "resolved" })
          .sort({ updatedAt: -1 })
          .limit(6)
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    });
    app.get('/issues/all', async (req, res) => {
      try {
        const { search, status, priority, category, page = 1, limit = 10 } = req.query;
        const query = {};

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
            { location: { $regex: search, $options: 'i' } }
          ];
        }

        if (status) query.status = status;
        if (priority) query.priority = priority;
        if (category) query.category = category;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await issuesCollection.countDocuments(query); 
        const result = await issuesCollection.find(query).skip(skip).limit(parseInt(limit)).sort({ priority: 1 }).toArray();

        res.send({
          data: result,
          total,
          page: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit))
        });
      } catch (error) {
        res.status(500).send({ message: 'Server Error' });
      }
    });
    app.get('/issues/all-admin', verifyFBToken, async (req, res) => {
      const result = await issuesCollection.find().sort({ priority: 1 }).toArray();
      res.send(result);
    })
    app.get('/issues/:id', verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const objectId = new ObjectId(id);
      const result = await issuesCollection.findOne({ _id: objectId });
      res.send(result);
    })
    app.get('/issues', verifyFBToken, async (req, res) => {
      const { email, status, category } = req.query;
      const query = {};

      if (email) query.reporterEmail = email;
      if (status) query.status = status;
      if (category) query.category = category;
      const option = {
        sort: { createdAt: -1 }
      }
      const result = await issuesCollection.find(query, option).toArray();
      res.send(result);
    });
    app.delete('/issues/:id', async (req, res) => {
      const { id } = req.params;
      const objectId = new ObjectId(id);
      const result = await issuesCollection.deleteOne({ _id: objectId });
      res.send(result);
    })
    app.put('/issues/:id', verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const email = req.decoded_email;
      const data = req.body;
      const objectId = new ObjectId(id);

      if (data.status) {
        const issue = await issuesCollection.findOne({ _id: objectId });

        if (!issue) {
          return res.status(404).send({ message: "Issue not found" });
        }
        const getStatusMessage = (status) => {
          if (status === "pending") {
            return "Issue marked as pending";
          }
          if (status === "in_progress") {
            return "Work started on the issue";
          }
          if (status === "working") {
            return "Issue is currently being worked on";
          }
          if (status === "resolved") {
            return "Issue marked as resolved";
          }
          if (status === "closed") {
            return "Issue closed by staff";
          }
        };
        const timelineEntry = {
          action: "STATUS_CHANGED",
          status: data.status,
          message: getStatusMessage(data.status),
          updatedBy: 'Staff',
          at: new Date()
        };
        const update = {
          $set: {
            ...data,
            updatedAt: new Date()
          },
          $push: { timeline: timelineEntry }
        }
        const result = await issuesCollection.updateOne({ _id: objectId }, update);
        res.send(result);
      } else {
        const update = {
          $set: data
        }
        const result = await issuesCollection.updateOne({ _id: objectId }, update);
        res.send(result);
      };
    })
    app.patch('/issues/:id/assign-staff', verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const { staff } = req.body;

      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (issue.assignedStaff) {
        return res.status(400).send({ message: 'Staff already assigned' });
      }

      const result = await issuesCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            assignedStaff: staff
          },
          $push: {
            timeline: {
              action: 'STAFF_ASSIGNED',
              message: 'Issue assigned to staff',
              updatedBy: 'Admin',
              at: new Date()
            }
          }
        }
      );

      res.send({ success: true });
    });
    app.patch('/issues/:id/reject', verifyFBToken, async (req, res) => {
      const { id } = req.params;

      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

      if (issue.status !== 'pending') {
        return res.status(400).send({ message: 'Only pending issues can be rejected' });
      }

      const result = await issuesCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { status: 'rejected' },
          $unset: { assignedStaff: "" },
          $push: {
            timeline: {
              action: 'ISSUE_REJECTED',
              message: 'Issue has been rejected',
              updatedBy: 'Admin',
              at: new Date()
            }
          }
        }
      );

      res.send({ success: true });
    });

    app.post('/issues/:id/upvote', verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const email = req.decoded_email;

      try {
        const user = await userCollection.findOne({ email });
        if (!user) {
          return res.status(401).send({ message: 'Unauthorized' });
        }

        if (user.status === 'blocked') {
          return res.status(403).send({
            message: 'Your account is blocked. You cannot upvote issues.'
          });
        }
        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
        if (!issue) return res.status(404).send({ message: 'Issue not found' });

        if (issue.reporterEmail === email) {
          return res.status(403).send({ message: 'You cannot upvote your own issue' });
        }

        if (issue.upVotes && issue.upVotes.includes(email)) {
          return res.status(400).send({ message: 'You already upvoted this issue' });
        }

        const result = await issuesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $push: { upVotes: email } }
        );

        const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });

        res.send({
          message: 'Upvoted successfully',
          upvoteCount: updatedIssue.upVotes ? updatedIssue.upVotes.length : 0
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server error' });
      }
    });

    // payment api
    app.post('/create-payment-intent', verifyFBToken, async (req, res) => {
      const email = req.decoded_email;

      const user = await userCollection.findOne({ email });

      if (user?.status === 'blocked') {
        return res.status(403).send({
          message: 'Your account is blocked. You cannot boost issues.'
        });
      }
      const paymentInfo = req.body;
      const amount = 79;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              unit_amount: amount,
              product_data: {
                name: `Issue boosting for Issue : ${paymentInfo.title}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.reporterEmail,
        mode: 'payment',
        metadata: {
          issueId: paymentInfo.issueId,
          name: paymentInfo.title,
          trackingId: paymentInfo.trackingId
        },
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/issues/${paymentInfo.issueId}?payment=failed`,
      });
      res.send({ url: session.url });
    });
    app.patch('/payment-success', async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const paymentExits = await paymentsCollection.findOne(query);

      if (session.payment_status === 'paid' && !paymentExits) {
        const issueId = session.metadata.issueId;
        const query = { _id: new ObjectId(issueId) };
        const update = {
          $set: {
            paymentStatus: 'paid',
            priority: 'High'
          },
          $push: {
            timeline: {
              action: 'ISSUE_BOOSTED',
              message: 'Issue has been boosted',
              updatedBy: 'Citizen',
              at: new Date()
            }
          }
        }
        const result = await issuesCollection.updateOne(query, update);
        const paymentRecord = {
          amount: session.amount_total / 100,
          currency: session.currency,
          email: session.customer_email,
          issueId: session.metadata.issueId,
          issueName: session.metadata.name,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: session.metadata.trackingId
        }
        if (session.payment_status === 'paid') {
          const paymentResult = await paymentsCollection.insertOne(paymentRecord);
          res.send({ updateResult: result, paymentResult: paymentResult });
        }
      }
    });
    app.get('/all-payments', verifyFBToken, async (req, res) => {
      const adminEmail = 'admin@gmail.com';
      if (req.decoded_email !== adminEmail) {
        return res.status(403).send({ message: 'access denied' })
      }

      const { from, to } = req.query;
      const query = {};

      if (from || to) {
        query.paidAt = {};
        if (from) query.paidAt.$gte = new Date(from);
        if (to) query.paidAt.$lte = new Date(to);
      }

      const result = await paymentsCollection.find(query).sort({ paidAt: -1 }).toArray();
      res.send(result);
    });
    //Citizen Aggregation Pipeline api
    const issueStatsPipeline = (email) => [
      {
        $match: { reporterEmail: email }
      },
      {
        $group: {
          _id: null,
          totalIssues: { $sum: 1 },

          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] }
          },

          inProgress: {
            $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] }
          },

          working: {
            $sum: { $cond: [{ $eq: ["$status", "working"] }, 1, 0] }
          },

          resolved: {
            $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] }
          }
        }
      }
    ];


    const paymentStatsPipeline = (email) => [
      { $match: { email } },
      {
        $group: {
          _id: null,
          totalPayments: { $sum: "$amount" },
          totalTransactions: { $sum: 1 }
        }
      }
    ];
    app.get('/citizen-dashboard-stats', async (req, res) => {
      const email = req.query.email;

      const issueStats = await issuesCollection
        .aggregate(issueStatsPipeline(email))
        .toArray();

      const paymentStats = await paymentsCollection
        .aggregate(paymentStatsPipeline(email))
        .toArray();

      res.send({
        issueStats: issueStats[0] || {
          totalIssues: 0,
          pending: 0,
          inProgress: 0,
          working: 0,
          resolved: 0,
        },
        paymentStats: paymentStats[0] || {
          totalPayments: 0,
          totalTransactions: 0
        }
      });
    });

    //Staff Aggregation Pipeline api
    const staffDashboardPipeline = (email) => [
      {
        $match: {
          "assignedStaff.email": email
        }
      },
      {
        $group: {
          _id: null,

          assignedIssues: { $sum: 1 },

          resolvedIssues: {
            $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] }
          },

          working: {
            $sum: { $cond: [{ $eq: ["$status", "working"] }, 1, 0] }
          },

          inProgress: {
            $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] }
          },

          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] }
          }
        }
      }
    ];

    const todayTaskPipeline = (staffEmail) => {
      const now = new Date();

      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

      return [
        {
          $match: {
            "assignedStaff.email": staffEmail,
            timeline: {
              $elemMatch: {
                action: "STAFF_ASSIGNED",
                at: { $gte: start, $lte: end }
              }
            }
          }
        }
      ];
    };
    app.get('/staff-dashboard-stats', async (req, res) => {
      const email = req.query.email;
      const statsArr = await issuesCollection
        .aggregate(staffDashboardPipeline(email))
        .toArray();

      const todayTasks = await issuesCollection
        .aggregate(todayTaskPipeline(email))
        .toArray();

      res.send({
        stats: statsArr[0] || {
          assignedIssues: 0,
          resolvedIssues: 0,
          working: 0,
          inProgress: 0,
          pending: 0
        },
        todayTasks: todayTasks || []
      });
    });

    //Admin Aggregation Pipeline api
    const adminIssueStatsPipeline = [
      {
        $group: {
          _id: null,
          totalIssues: { $sum: 1 },
          resolved: { $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } }
        }
      }
    ];

    const adminPaymentStatsPipeline = [
      {
        $group: {
          _id: null,
          totalPayments: { $sum: "$amount" },
          totalTransactions: { $sum: 1 }
        }
      }
    ];

    const latestIssuesPipeline = [
      { $sort: { createdAt: -1 } },
      { $limit: 5 }
    ];

    const latestPaymentsPipeline = [
      { $sort: { paidAt: -1 } },
      { $limit: 5 }
    ];

    const latestUsersPipeline = [
      { $sort: { createdAt: -1 } },
      { $limit: 5 }
    ];
    app.get("/admin-dashboard-stats", async (req, res) => {
      try {
        const issueStats = await issuesCollection.aggregate(adminIssueStatsPipeline).toArray();
        const paymentStats = await paymentsCollection.aggregate(adminPaymentStatsPipeline).toArray();
        const latestIssues = await issuesCollection.aggregate(latestIssuesPipeline).toArray();
        const latestPayments = await paymentsCollection.aggregate(latestPaymentsPipeline).toArray();
        const latestUsers = await userCollection.aggregate(latestUsersPipeline).toArray();

        res.send({
          issueStats: issueStats || { totalIssues: 0, resolved: 0, pending: 0, rejected: 0 },
          paymentStats: paymentStats || { totalPayments: 0, totalTransactions: 0 },
          latestIssues,
          latestPayments,
          latestUsers
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Server Error" });
      }
    });




    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello World!')
})

module.exports = app;