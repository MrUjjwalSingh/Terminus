import express from "express";
import http from "http";
import {Server} from "socket.io";
import { redisClient,connectRedis } from "./src/config/redis.js";
import { socketAuthMiddleware } from "./src/middleware/auth.js";
import dotenv from 'dotenv';

dotenv.config();
const app = express();

//Wrap express with the raw HTTP server
const server = http.createServer(app);

//Initialise Socket.io with cors , here the Server is the whole WebSocketManager which looks for incoming and outgoing and other socket connection req
const io = new Server(server , {
    cors : {
        origin: "http://localhost:3000",  //frontend port
        methods: ['GET' , 'POST']
    }
})

app.get('/' , (req,res)=>{
    res.send("Cab Pool(Terminus) backend is live");
})


const userSocketMap = new Map();

//Applying the middleware 
io.use(socketAuthMiddleware);

//Listen for web socket connection
io.on('connection',(socket)=>{ //here we create the connection and store the returning socket connection to socket variable 
    const userId = socket.userId;   //Grab the verified userId from the supabase

    //Add the connection to the map
    userSocketMap.set(userId , socket.id);
    console.log(`user ${userId} connected , Map size : ${userSocketMap.size}`);

    //Delete the socket instance and its record from the map once the connection is disconnected
    socket.on('disconnect' , ()=>{
        //Remove the entry from the map on disconnect
        userSocketMap.delete(userId);
        console.log(`UserId disconnected ${userId} , Map size : ${userSocketMap.size}`);
    })
})

const PORT = process.env.PORT || 4000;

//Blocking Initialization such that the server only start once the redisClient is initialized
async function startServer(){
    try {
        await connectRedis();  //Boot up redis first
        console.log("Connected to redis client successfully");

        //after the redis is connected we can start the server
        server.listen(PORT , ()=>{
            console.log(`Server connected on port: ${PORT}`);
        })
    } catch (error) {
        console.error("Failed to start the server because Redis failed to connect:",error);
        process.exit(1);  //Kill the process if Redis is dead
    }
}

startServer();