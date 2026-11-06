import express from "express";
import http from "http";
import {Server} from "socket.io";
import { redisClient,connectRedis } from "./src/config/redis.js";
import { socketAuthMiddleware } from "./src/middleware/auth.js";
import dotenv from 'dotenv';
import geohash from 'ngeohash';

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


    socket.on('find-pool' , async(data)=>{
        //The frontend sends the data object to the backend using the emit to find-pool and we deconstruct it to access it here
        const {pickupLng , pickupLat , destLng , destLat , partySize , preferedVehicle , baselineFare} = data;

        if(!pickupLng || !pickupLat || !destLng || !destLat){
            return socket.emit("Error ", " Missing Location coordinates");
        }

        if(!partySize || !preferedVehicle || !baselineFare){
            return socket.emit("Error" , "Missing required pool parameters");
        }
        
        try {
            // 1. Generate the Destination Hotspot (Precision 5 = ~4.9km grid)
            //Everyone inside this 5 km hotspot gets dropped inside the same bucket for pool matching
            const destHotspot = geohash.encode(destLat , destLng ,5);
            const queueKey = `queue:${destHotspot}`;

            //2.Adding the nearby users who want to go to the same hotspots 
            await redisClient.geoAdd(queueKey,{
                longitude : pickupLng,
                latitude : pickupLat,
                member : userId
            })

            //3.Storing the user constraints i.e their metadata
            const userRequestKey = `request:${userId}`;
            await redisClient.hSet(userRequestKey , {
                party_size : partySize.toString(),
                preferred_vehicle : preferedVehicle,
                baseline_fare : baselineFare.toString(),
                pickup_lng : pickupLng.toString(),
                pickup_lat : pickupLat,
                dest_lng : destLng.toString(),
                dest_lat : destLat.toString()
            })

            //an expiry of 10 minutes if the user closes the app
            await redisClient.expire(userRequestKey , 600);

            console.log(`User ${userId} joined the hotspot ${destHotspot}`);
            socket.emit('pool-joined' , {status:'waiting' , queue:queueKey});

        } catch (error) {
            console.error("Redis intake error:",error);
            socket.emit("error","Failed to join matching pool");
        }
    })


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
            //simultaneously start the matchmaker worker to start finding other users for pool
            //Passing the io instance and userSocketMap to the worker
            startMatchmaker(io , userSocketMap);
        })
    } catch (error) {
        console.error("Failed to start the server because Redis failed to connect:",error);
        process.exit(1);  //Kill the process if Redis is dead
    }
}

startServer();