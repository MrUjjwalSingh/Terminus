import { redisClient } from '../config/redis.js';
import { calculateEstimatedFare, getRouteMetrics } from '../services/olaMaps.js';

//We keep running this loop continuously in the background
export const startMatchmaker = (io , userSocketMap) =>{
    console.log("Matchmaker worker started. Scanning for pools ...");

    setInterval(async()=>{
        try {
            const queues = await redisClient.sMembers('active_queues');

            for(const queueKey of queues){
                const waitingUsers = await redisClient.zRange(queueKey , 0 ,-1); //zRange returns a sorted set and we get all its elements from first to last

                //deleting the queue with the queueKey which does not have any member
                if(waitingUsers.length === 0){
                    await redisClient.sRem('active_queues',queueKey);
                    continue;
                }

                if(waitingUsers.length < 2){
                    continue;
                }

                //1.Prefetch every waiting user's hash into the ram which are currently in the queue for a destination
                const userRequests = new Map();
                for(const userId of waitingUsers){
                    const req = await redisClient.hGetAll(`request:${userId}`);
                    if(req && req.party_size){
                        userRequests.set(userId , req);
                    }
                }

                //2.Building a global list of all valid candidate pairs in this bin/queue
                const candidatePairs = [];
                const seenPairs = new Set();

                for(const anchorUser of waitingUsers){
                    const reqA = userRequests.get(anchorUser);
                    if(!reqA) continue;

                    //Fetching the neighbours within 1 km from this user
                    const nearby = await redisClient.geoSearchWith(
                        queueKey , 
                        {member : anchorUser},
                        {radius : 1 , unit : 'km'},
                        ['WITHDIST'],
                        {SORT : 'ASC'}
                    )

                    for(const neighbour of nearby){
                        const otherUser = neighbour.member;
                        if(otherUser === anchorUser) continue;

                        const pairKey = [anchorUser , otherUser].sort().join(':');
                        if(seenPairs.has(pairKey)) continue;

                        seenPairs.add(pairKey);

                        const reqB = userRequests.get(otherUser);
                        if(!reqB) continue;

                        //Capacity check
                        const totalPax = parseInt(reqA.party_size) + parseInt(reqB.party_size);
                        if(totalPax > 4) continue;

                        candidatePairs.push({
                            userA : anchorUser,
                            userB : otherUser,
                            reqA,
                            reqB,
                            distanceKm : parseFloat(neighbour.distance)
                        })
                    }
                }

                candidatePairs.sort((a,b)=> a.distanceKm - b.distanceKm);

                //4.Walk sorted pairs : lock non overlapping winners and verify fares
                const alreadyMatched = new Set();

                for(const pair of candidatePairs){
                    const {userA , userB , reqA , reqB} = pair;

                    //Guard 1:skip the pair if either of the user has already been matched 
                    if(alreadyMatched.has(userA) || alreadyMatched.has(userB)){
                        continue;
                    }

                    //Guard 2:Lock both of the users out of the queue individually
                    const remA = await redisClient.zRem(queueKey , userA);
                    const remB = await redisClient.zRem(queueKey , userB);

                    if(remA === 0 || remB === 0){
                        //One of the rider cancelled the match or vanished midway
                        if(remA === 1){
                            await redisClient.geoAdd(queueKey , {
                                longitude : parseFloat(reqA.pickup_lng),
                                latitude : parseFloat(reqA.pickup_lat),
                                member : userA
                            })
                        }
                        if(remB === 1){
                            await redisClient.geoAdd(queueKey , {
                                longitude : parseFloat(reqB.pickup_lng),
                                latitude : parseFloat(reqB.pickup_lat),
                                member:userB
                            })
                        }
                        continue;
                    }
                

                    //Now we have a match and now we apply the ola maps api math for rest part
                    //The Financial Math
                
                    console.log(`Checking financials for ${userA} and ${userB}...`);
                    //1.Fetch real world distance and time from olaMaps
                    //Then fetch pickup coordinates from the hash
                    const routeMetrics = await getRouteMetrics(
                        reqA.pickup_lat , reqA.pickup_lng , reqA.dest_lat , reqA.dest_lng
                    );

                    //If ola api crashes or returns null
                    if(!routeMetrics){
                        console.log(`Ola api failed , restoring ${userA} and ${userB} to queue`);
                        await redisClient.geoAdd(queueKey , [
                            {longitude : reqA.pickup_lng , latitude:reqA.pickup_lat , member:userA},
                            {longitude : reqB.pickup_lng , latitude:reqB.pickup_lat , member:userB}
                        ]);
                        continue;
                    }

                    //2.Calculate the estimated fare for a mini
                    const sharedFare = calculateEstimatedFare(routeMetrics.distanceKm , routeMetrics.durationMins , 'Mini');

                    //3.The platform cut and split logic
                    const baselineA = parseInt(reqA.baseline_fare);
                    const baselineB = parseInt(reqB.baseline_fare);
                    const totalBaseline = baselineA + baselineB //The total regular fare without share
                    const totalSavings = totalBaseline - sharedFare ; //Estimated profit/savings by the two parties combined

                    if(totalSavings <= 1/10 * totalBaseline){
                        console.log(`Financials failed. No efficient savings generated.`);
                        await redisClient.geoAdd(queueKey , [
                            {longitude : reqA.pickup_lng , latitude : reqA.pickup_lat  , member: userA},
                            {longitude : reqB.pickup_lng , latitude : reqB.pickup_lat  , member: userB},
                        ])
                        continue;
                    }

                    //3.Proportional split
                    const ratioA = baselineA / totalBaseline;
                    const ratioB = baselineB / totalBaseline;

                    const rawCostA = sharedFare * ratioA;
                    const rawCostB = sharedFare * ratioB;

                    const savingsA = baselineA - rawCostA;
                    const savingsB = baselineB - rawCostB;
                    
                    const PlatformCut = 0.30;
                    const feeA = savingsA * PlatformCut;
                    const feeB = savingsB * PlatformCut;

                    const finalBillA = Math.round(rawCostA + feeA);
                    const finalBillB = Math.round(rawCostB + feeB);
                    console.log("Match found");
                    console.log(`User A pays: ₹${finalBillA} (Started at ₹${baselineA})`);
                    console.log(`User B pays: ₹${finalBillB} (Started at ₹${baselineB})`);
                    console.log(`Terminus Revenue: ₹${Math.round(feeA + feeB)}`);

                    const socketIdA = userSocketMap.get(userA);
                    const socketIdB = userSocketMap.get(userB);

                    const matchPayloadA = {
                        status : 'match_found',
                        vehicle : 'Mini',
                        totalFare : sharedFare,
                        yourSplit : finalBillA ,
                        platformFee : feeA,
                        matchedUserId : 'Hidden for privacy until accepted ...',
                        expiresIn : 90
                    }
                    const matchPayloadB = {
                        status : 'match_found',
                        vehicle : 'Mini',
                        totalFare : sharedFare,
                        yourSplit : finalBillB,
                        platformFee : feeB,
                        matchedUserId : 'Hidden for privacy until accepted ...',
                        expiresIn : 90
                    }

                    //Guard 3. Fare passed ,mark both as claimed and emit match_found
                    alreadyMatched.add(userA);
                    alreadyMatched.add(userB);

                    if(socketIdA){
                        io.to(socketIdA).emit('match_found',{...matchPayloadA , saved : baselineA - finalBillA});
                    }
                    if(socketIdB){
                        io.to(socketIdB).emit('match_found',{...matchPayloadB , saved : baselineB - finalBillB});
                    }
                

                }
            }
        } 
        catch (error) {
            console.error("Matchmaker Error:",error);
        }
    },5000);
}