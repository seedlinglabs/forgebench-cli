---------------- MODULE Owner ----------------
EXTENDS Naturals
CONSTANTS BindPrincipal, VerifyOriginal
VARIABLES key, pending, binding, credential, verifiedKey, sent, recipient
vars == <<key, pending, binding, credential, verifiedKey, sent, recipient>>
Principal(k) == IF k \in {1, 2} THEN <<1, 1>> ELSE IF k = 3 THEN <<2, 1>> ELSE <<1, 2>>
Init == /\ key = 1 /\ pending = FALSE /\ binding = <<0, 0>> /\ credential = 0
        /\ verifiedKey = 0 /\ sent = FALSE /\ recipient = <<0, 0>>
Enqueue == /\ ~pending /\ ~sent /\ key = 1
           /\ pending' = TRUE /\ credential' = 1 /\ binding' \in {<<0, 0>>, Principal(1)}
           /\ UNCHANGED <<key, verifiedKey, sent, recipient>>
Legacy == /\ ~pending /\ ~sent /\ key = 1
          /\ pending' = TRUE /\ credential' = 0 /\ binding' = <<0, 0>>
          /\ UNCHANGED <<key, verifiedKey, sent, recipient>>
Switch == /\ key' \in 1..4 /\ UNCHANGED <<pending, binding, credential, verifiedKey, sent, recipient>>
Whoami == /\ pending /\ verifiedKey' = key
          /\ UNCHANGED <<key, pending, binding, credential, sent, recipient>>
Bind == /\ pending /\ binding = <<0, 0>> /\ verifiedKey = key
        /\ (~VerifyOriginal \/ credential = key)
        /\ binding' = Principal(key)
        /\ UNCHANGED <<key, pending, credential, verifiedKey, sent, recipient>>
Deliver == /\ pending /\ verifiedKey = key
           /\ (~BindPrincipal \/ binding = Principal(key))
           /\ pending' = FALSE /\ sent' = TRUE /\ recipient' = Principal(key)
           /\ UNCHANGED <<key, binding, credential, verifiedKey>>
Restart == /\ verifiedKey' = 0 /\ UNCHANGED <<key, pending, binding, credential, sent, recipient>>
Next == Enqueue \/ Legacy \/ Switch \/ Whoami \/ Bind \/ Deliver \/ Restart
NoCrossPrincipalDelivery == sent => recipient = Principal(1)
LegacyNeverAdopted == credential = 0 => binding = <<0, 0>>
==============================================
