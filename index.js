require('dotenv').config()
const express = require('express')
const cors = require('cors')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express()
const port = process.env.PORT || 3000
const admin = require("firebase-admin");

const serviceAccount = require("./issue-reporting-system--firebase-admin.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// middleware
app.use(express.json())
app.use(cors())

const verifyFBToken = async(req, res, next) => {
  const token = req.headers.authorization;
  if(!token){
    return res.status(401).send({message: 'unauthorized access'})
  }
  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email
  } catch (error) {
    return res.status(401).send({message: 'unauthorized access'})
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
    await client.connect();

    const db = client.db("issue_reporting_system");
    const issuesCollection = db.collection("issues");
    const paymentsCollection = db.collection("payments");
    // issue api
    app.post('/issues', async (req, res) => {
      const issue = req.body;
      issue.trackingId = generateTrackingId();
      issue.priority = "Normal";
      issue.paymentStatus = "unpaid";
      const result = await issuesCollection.insertOne(issue);
      res.send(result);
    });
    app.get('/issues/all', async (req, res) => {
      const result = await issuesCollection.find({}, { sort: { priority: -1 } }).toArray();
      res.send(result);
    });
    app.get('/issues/:id', async (req, res) => {
      const { id } = req.params;
      const objectId = new ObjectId(id);
      const result = await issuesCollection.findOne({ _id: objectId });
      res.send(result);
    })
    app.get('/issues', async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.reporterEmail = email;
      }
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
    app.put('/issues/:id', async (req, res) => {
      const { id } = req.params;
      const data = req.body;
      const objectId = new ObjectId(id);
      const update = {
        $set: data
      }
      const result = await issuesCollection.updateOne({ _id: objectId }, update);
      res.send(result);
    })
    // payment api
    app.post('/create-payment-intent', async (req, res) => {
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
        success_url: `${process.env.SITE_DOMAIN}/issues/${paymentInfo.issueId}?session_id={CHECKOUT_SESSION_ID}`,
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
      // admin email
      const adminEmail = 'sd3034734@gmail.com';
      if(req.decoded_email !== adminEmail){
        return res.status(403).send({message: ' access'})
      }
      const result = await paymentsCollection.find().sort({ paidAt: -1 }).toArray();
      res.send(result);
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
