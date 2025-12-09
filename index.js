const express = require('express')
const cors = require('cors')
const app = express()
require('dotenv').config()
const port = process.env.PORT || 3000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// middleware
app.use(express.json())
app.use(cors())

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.kfapxri.mongodb.net/?appName=Cluster0`;

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

    // issue api
    app.post('/issues', async (req, res) => {
        const issue = req.body;
        const result =  await issuesCollection.insertOne(issue);
        res.send(result);
    });
    app.get('/issues/all', async (req, res) => {
        const result =  await issuesCollection.find().toArray();
        res.send(result);
    });
    app.get('/issues/:id', async (req, res)=>{
      const {id} = req.params;
      const objectId = new ObjectId(id);
      const result = await issuesCollection.findOne({_id: objectId});
      res.send(result);
    })
    app.get('/issues', async (req, res) => {
        const email = req.query.email;
        const query = {};
        if(email){
            query.reporterEmail = email;
        }
        const result =  await issuesCollection.find(query).toArray();
        res.send(result);
    });


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
